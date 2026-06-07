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

      const { userId, phone, amount, withdrawalId } = await req.json();

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
      );

      // Check if user has sufficient balance
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('wallet_balance')
        .eq('id', userId)
        .single();

      if (profileError) throw new Error('User not found');
      if (profile.wallet_balance < amount) throw new Error('Insufficient balance');

      const reference = `PAYOUT-${Date.now()}-${crypto.randomUUID().substring(0, 8).toUpperCase()}`;

      // Authenticate with Pesapal
      const authUrl = "https://pay.pesapal.com/v3/api/Auth/RequestToken";
      const authResponse = await fetch(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consumer_key: consumerKey, consumer_secret: consumerSecret })
      });

      const authData = await authResponse.json();
      if (!authData.token) throw new Error('Pesapal auth failed');

      // Initiate payout
      const payoutUrl = "https://pay.pesapal.com/v3/api/transactions/disburse";
      const payoutResponse = await fetch(payoutUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${authData.token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: reference,
          currency: "UGX",
          amount: amount,
          recipient: {
            phone_number: phone,
            email: profile.email || "user@thebrandingcompany.com"
          },
          description: "The Branding Company - Publisher Withdrawal"
        })
      });

      const payoutData = await payoutResponse.json();

      if (!payoutResponse.ok) {
        throw new Error(`Payout failed: ${JSON.stringify(payoutData)}`);
      }

      // Update withdrawal request status
      if (withdrawalId) {
        await supabase
          .from('withdrawal_requests')
          .update({
            status: 'completed',
            processed_at: new Date().toISOString(),
            transaction_reference: reference
          })
          .eq('id', withdrawalId);
      }

      // Deduct from user's wallet
      await supabase.rpc('decrement_wallet_balance', {
        user_id: userId,
        amount: amount
      });

      // Create transaction record
      await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          amount: amount,
          fee: 0,
          net_amount: amount,
          currency: 'UGX',
          transaction_type: 'withdrawal',
          status: 'completed',
          reference: reference,
          phone_number: phone,
          description: 'Mobile money withdrawal',
          completed_at: new Date().toISOString()
        });

      return new Response(
        JSON.stringify({ success: true, reference: reference }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );

    } catch (error) {
      console.error('Payout error:', error);
      return new Response(
        JSON.stringify({ error: error.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
      );
    }
  }
}
