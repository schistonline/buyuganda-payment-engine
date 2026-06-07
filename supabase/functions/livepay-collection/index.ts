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
        throw new Error("Missing Pesapal Consumer Credentials in Supabase Secrets.");
      }

      const { userId, phone, amount } = await req.json();

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      // Generate a clean transaction tracking reference for the database
      const txReference = `PESA-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

      const { error: dbError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          amount: parseFloat(amount),
          currency: 'UGX',
          tx_type: 'collection',
          status: 'pending',
          phone_number: phone,
          tx_reference: txReference
        });

      if (dbError) throw new Error(`Database Write Rejected: ${dbError.message}`);

      // --- STAGE 1: AUTHENTICATE WITH PESAPAL ---
      // For Production Live Money, use: https://pay.pesapal.com/v3/api/Auth/RequestToken
      const authUrl = "https://pay.pesapal.com/v3/api/Auth/RequestToken";
      
      const authResponse = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          consumer_key: consumerKey,
          consumer_secret: consumerSecret
        })
      });

      const authData = await authResponse.json();
      if (!authResponse.ok || !authData.token) {
        throw new Error(`Pesapal Authentication Failed: ${JSON.stringify(authData)}`);
      }

      const bearerToken = authData.token;

      // --- STAGE 2: SUBMIT TRANSACTION ORDER ---
      // For Production Live Money, use: https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest
      const orderUrl = "https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest";
      
      const orderResponse = await fetch(orderUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${bearerToken}`,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          id: txReference,
          currency: "UGX",
          amount: parseFloat(amount),
          description: "Marketplace Wallet Deposit",
          callback_url: "https://buyunganda.online",
          redirect_mode: "TOP_WINDOW",
          billing_address: {
            phone_number: phone,
            email_address: "merchant_test@buyunganda.online"
          }
        })
      });

      const orderData = await orderResponse.json();
      if (!orderResponse.ok) {
        throw new Error(`Pesapal Order Request Failed: ${JSON.stringify(orderData)}`);
      }

      // Extract secure redirect link from the structured response
      const checkoutUrl = orderData.redirect_url;
      if (!checkoutUrl) {
        throw new Error(`Order accepted but no redirect URL was handed back: ${JSON.stringify(orderData)}`);
      }

      return new Response(
        JSON.stringify({ success: true, paymentUrl: checkoutUrl }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );

    } catch (error) {
      return new Response(
        JSON.stringify({ error: error.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }
  }
}
