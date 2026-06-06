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
      const payoutAmount = parseFloat(amount);

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      // 1. Verify user profile balance before executing outbound money transfers
      const { data: profile } = await supabase
        .from('profiles')
        .select('wallet_balance')
        .eq('id', userId)
        .single();

      if (!profile || profile.wallet_balance < payoutAmount) {
        throw new Error("Insufficient marketplace ledger wallet balance.");
      }

      const txReference = `PAY-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

      // 2. Insert trace record inside transactions list table
      const { error: dbError } = await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          amount: payoutAmount,
          currency: 'UGX',
          tx_type: 'payout',
          status: 'pending',
          phone_number: phone,
          tx_reference: txReference
        });

      if (dbError) throw new Error(`Database Payout Trace Fail: ${dbError.message}`);

      // 3. Dispatch cash out request directly to LivePay's processing core
      const gatewayUrl = "https://api.paysecure.net/api/v1/payouts";
      const response = await fetch(gatewayUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          brand_id: brandId,
          amount: payoutAmount,
          currency: "UGX",
          client: { phone: phone, email: "merchant_test@buyunganda.online" },
          external_id: txReference
        })
      });

      const gatewayResponse = await response.json();

      if (!response.ok) {
        throw new Error(`Gateway Payout Execution Failed: ${JSON.stringify(gatewayResponse)}`);
      }

      return new Response(
        JSON.stringify({ success: true, message: "Payout queued and processing safely." }),
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
