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
        throw new Error("Missing Pesapal API credentials");
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

      // --- STAGE 2: REGISTER IPN (CRITICAL FOR PIN NOTIFICATION) ---
      // This MUST be done for each merchant or use a static IPN ID
      const ipnUrl = "https://pay.pesapal.com/v3/api/URLSetup/RegisterIPN";
      const ipnResponse = await fetch(ipnUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          url: "https://yourdomain.com/api/pesapal/ipn", // Replace with your actual domain
          ipn_notification_type: "POST"
        })
      });

      const ipnData = await ipnResponse.json();
      
      // Get IPN ID - THIS IS CRITICAL for PIN notification to work
      let activeIpnId = ipnData.ipn_id;
      
      // If registration failed, try to use a pre-registered IPN ID from environment
      if (!activeIpnId) {
        console.warn('IPN registration response:', ipnData);
        activeIpnId = Deno.env.get('PESAPAL_IPN_ID'); // Fallback to static IPN ID
      }
      
      if (!activeIpnId) {
        throw new Error('IPN ID is required for PIN notifications. Please register IPN in Pesapal dashboard.');
      }

      // Get user email
      const { data: profile } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', userId)
        .single();

      const userEmail = profile?.email || 'customer@thebrandingcompany.com';
      const userFullName = profile?.full_name || 'Customer';

      // --- STAGE 3: SUBMIT ORDER WITH CORRECT FORMAT ---
      const orderUrl = "https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest";
      
      // IMPORTANT: The order payload format matters for PIN notification
      const orderPayload = {
        id: txReference,
        currency: "UGX",
        amount: parseFloat(amount),
        description: "The Branding Company - Wallet Deposit",
        callback_url: "https://yourdomain.com/pesapal-callback.html", // Replace with actual domain
        notification_id: activeIpnId, // CRITICAL: This enables PIN notification
        redirect_mode: "TOP_WINDOW",
        billing_address: {
          email_address: userEmail,
          phone_number: phone,
          country_code: "UG",
          first_name: userFullName.split(' ')[0] || '',
          last_name: userFullName.split(' ')[1] || '',
          line1: "N/A"
        },
        line_items: [
          {
            unique_id: txReference,
            description: "Wallet Deposit",
            amount: parseFloat(amount),
            quantity: 1,
            total_amount: parseFloat(amount)
          }
        ]
      };

      console.log('Submitting order with payload:', JSON.stringify(orderPayload, null, 2));

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
        console.error('Order submission failed:', orderData);
        throw new Error(`Pesapal order failed: ${JSON.stringify(orderData)}`);
      }

      const checkoutUrl = orderData.redirect_url;
      
      if (!checkoutUrl) {
        throw new Error(`No redirect URL received: ${JSON.stringify(orderData)}`);
      }

      // Also store the pesapal_order_request for reference
      await supabase
        .from('transactions')
        .update({
          metadata: {
            pesapal_order_request: orderData,
            ipn_id: activeIpnId
          }
        })
        .eq('reference', txReference);

      return new Response(
        JSON.stringify({ 
          success: true, 
          paymentUrl: checkoutUrl, 
          reference: txReference,
          orderData: orderData
        }),
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
