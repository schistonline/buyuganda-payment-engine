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
      const apiKey = Deno.env.get('LIVEPAY_API_KEY');
      const brandId = Deno.env.get('LIVEPAY_BRAND_ID');

      if (!apiKey || !brandId) {
        throw new Error("Missing LivePay Secrets in your Supabase dashboard settings.");
      }

      const { userId, phone, amount } = await req.json();

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      const txReference = `COLL-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

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

      // The standard optimized processing route
      const gatewayUrl = "https://api.livepay.me/v1/charges";
      
      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: parseFloat(amount),
          currency: "UGX",
          phone_number: phone,
          description: "Wallet Deposit",
          reference: txReference,
          brand_id: brandId,
          redirect_url: "https://buyunganda.online"
        })
      });

      // Handle raw non-JSON structural failures instantly before trying to decode
      const textData = await response.text();
      let gatewayData;
      
      try {
        gatewayData = JSON.parse(textData);
      } catch (e) {
        throw new Error(`Gateway returned raw HTML text instead of JSON payload data: ${textData.substring(0, 100)}`);
      }

      if (!response.ok) {
        throw new Error(`Gateway Verification Failed: ${JSON.stringify(gatewayData)}`);
      }

      return new Response(
        JSON.stringify({ 
          success: true, 
          paymentUrl: gatewayData.checkout_url || gatewayData.redirect_url || gatewayData.url || gatewayData.data?.link 
        }),
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
