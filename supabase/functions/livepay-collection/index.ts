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
      const brandId = Deno.env.get('LIVEPAY_BRAND_ID'); // Your Key ID: e.g., 5834fae99da01117

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

      // Official documented production environment endpoint
      const gatewayUrl = "https://api.paysecure.net/api/v1/purchases";
      
      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`, // Standard clean authorization mapping
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          client: { 
            email: "customer@buyunganda.online", 
            phone: phone 
          },
          purchase: { 
            currency: "UGX", 
            products: [{ name: "Wallet Deposit", price: parseFloat(amount) }] 
          },
          brand_id: brandId, // Your Key ID connects the purchase to your specific profile routing
          success_redirect_url: "https://buyunganda.online",
          failure_redirect_url: "https://buyunganda.online"
        })
      });

      const textData = await response.text();
      let gatewayData;
      
      try {
        gatewayData = JSON.parse(textData);
      } catch (e) {
        throw new Error(`Gateway returned non-JSON text payload: ${textData.substring(0, 200)}`);
      }

      if (!response.ok) {
        throw new Error(`Gateway Verification Failed: ${JSON.stringify(gatewayData)}`);
      }

      // Check all possible return fields for the generated checkout redirection string
      const redirectLink = gatewayData.checkout_url || gatewayData.redirect_url || gatewayData.url || gatewayData.data?.link;

      if (!redirectLink) {
        throw new Error(`Handshake succeeded but no checkout URL was generated. Response: ${JSON.stringify(gatewayData)}`);
      }

      return new Response(
        JSON.stringify({ success: true, paymentUrl: redirectLink }),
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
