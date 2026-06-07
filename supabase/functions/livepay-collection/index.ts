import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}

export default {
  async fetch(req: Request) {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: corsHeaders })
    }

    try {
      const consumerKey = Deno.env.get('PESAPAL_CONSUMER_KEY');
      const consumerSecret = Deno.env.get('PESAPAL_CONSUMER_SECRET');

      if (!consumerKey || !consumerSecret) {
        throw new Error("Missing Pesapal API credentials. Set PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET in Supabase secrets.");
      }

      const { userId, phone, amount, campaignId } = await req.json();

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      // Generate unique reference
      const txReference = `TBC-${Date.now()}-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

      // Insert transaction record
      const { error: dbError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          amount: parseFloat(amount),
          fee: parseFloat(amount) * 0.02,
          net_amount: parseFloat(amount) - (parseFloat(amount) * 0.02),
          currency: 'UGX',
          transaction_type: 'deposit',
          status: 'pending',
          phone_number: phone,
          reference: txReference,
          campaign_id: campaignId || null,
          description: campaignId ? 'Campaign budget top-up' : 'Wallet deposit'
        });

      if (dbError) throw new Error(`Database error: ${dbError.message}`);

      // --- STAGE 1: AUTHENTICATE WITH PESAPAL ---
      const authUrl = "https://pay.pesapal.com/v3/api/Auth/RequestToken";
      const authResponse = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ consumer_key: consumerKey, consumer_secret: consumerSecret })
      });

      const authData = await authResponse.json();
      if (!authResponse.ok || !authData.token) {
        throw new Error(`Pesapal auth failed: ${JSON.stringify(authData)}`);
      }

      const bearerToken = authData.token;

      // --- STAGE 2: REGISTER IPN (Instant Payment Notification) ---
      const ipnUrl = "https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN";
      const ipnResponse = await fetch(ipnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          url: "https://yourdomain.com/pesapal-callback.html",
          ipn_notification_type: "POST"
        })
      });

      const ipnData = await ipnResponse.json();
      
      // Get IPN ID from response
      const activeIpnId = ipnData.ipn_id || ipnData.notification_id;
      
      if (!activeIpnId) {
        console.warn('IPN registration warning:', ipnData);
        // Fallback to a default IPN ID if needed, or continue without it
        // Some Pesapal implementations work without explicit IPN
      }

      // Get user email for billing
      const { data: profile } = await supabase
        .from('profiles')
        .select('email')
        .eq('id', userId)
        .single();

      const userEmail = profile?.email || 'customer@thebrandingcompany.com';

      // --- STAGE 3: SUBMIT ORDER TO PESAPAL ---
      const orderUrl = "https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest";
      const orderPayload: any = {
        id: txReference,
        currency: "UGX",
        amount: parseFloat(amount),
        description: "The Branding Company - Wallet Deposit",
        callback_url: "https://yourdomain.com/pesapal-callback.html",
        redirect_mode: "TOP_WINDOW",
        billing_address: {
          phone_number: phone,
          email_address: userEmail
        }
      };

      // Add notification_id only if we have one
      if (activeIpnId) {
        orderPayload.notification_id = activeIpnId;
      }

      const orderResponse = await fetch(orderUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(orderPayload)
      });

      const orderData = await orderResponse.json();
      
      if (!orderResponse.ok) {
        throw new Error(`Pesapal order failed: ${JSON.stringify(orderData)}`);
      }

      const checkoutUrl = orderData.redirect_url;
      
      if (!checkoutUrl) {
        throw new Error(`No redirect URL received: ${JSON.stringify(orderData)}`);
      }

      return new Response(
        JSON.stringify({ success: true, paymentUrl: checkoutUrl, reference: txReference }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );

    } catch (error) {
      console.error('Collection error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }
  }
}
