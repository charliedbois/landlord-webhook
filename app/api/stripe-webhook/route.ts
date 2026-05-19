import { NextRequest, NextResponse } from 'next/server'; import Stripe from 'stripe'; import { Pool } from 'pg';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-04-10' }); const db = new Pool({ connectionString: process.env.DATABASE_URL });

// Map your real Stripe Price IDs → plan config 
const PRICE_MAP: Record<string, { plan: string; inspections_limit: number | null }> = { 
  price_1TYbaLL4xZCIb8n8fu5RtETl: { plan: 'starter', inspections_limit: 10 }, 
  price_1TYbbAL4xZCIb8n8ZgT8oDC7: { plan: 'pro', inspections_limit: null }, 
};

export async function POST(req: NextRequest) { const rawBody = await req.text(); const sig = req.headers.get('stripe-signature') ?? '';

let event: Stripe.Event; try { event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET!); } catch (err: any) { console.error('Webhook signature verification failed:', err.message); return NextResponse.json({ error: 'Invalid signature' }, { status: 400 }); }

try { switch (event.type) {
  // ── New subscription created via Checkout ──────────────────────────────
  case 'checkout.session.completed': {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== 'subscription') break;

    const userEmail = session.metadata?.user_email ?? session.customer_email ?? '';
    const planId    = session.metadata?.plan ?? '';
    if (!userEmail || !planId) break;

    const priceId   = await getPriceIdFromSubscription(session.subscription as string);
    const planCfg   = priceId ? PRICE_MAP[priceId] : null;
    const limit     = planCfg?.inspections_limit ?? null;
    const plan      = planCfg?.plan ?? planId;

    await upsert(userEmail, plan, limit, session.customer as string, session.subscription as string);
    break;
  }

  // ── Subscription renewed or plan changed ──────────────────────────────
  case 'customer.subscription.updated': {
    const sub = event.data.object as Stripe.Subscription;
    const priceId = sub.items.data[0]?.price?.id ?? '';
    const planCfg = PRICE_MAP[priceId];
    if (!planCfg) break;

    const userEmail = await getEmailFromCustomer(sub.customer as string);
    if (!userEmail) break;

    await upsert(
      userEmail,
      planCfg.plan,
      planCfg.inspections_limit,
      sub.customer as string,
      sub.id,
    );
    break;
  }

  // ── Subscription cancelled ────────────────────────────────────────────
  case 'customer.subscription.deleted': {
    const sub = event.data.object as Stripe.Subscription;
    const userEmail = await getEmailFromCustomer(sub.customer as string);
    if (!userEmail) break;

    // Downgrade to free
    await upsert(userEmail, 'free', 3, sub.customer as string, '');
    break;
  }
}

} catch (err) { console.error('Webhook handler error:', err); return NextResponse.json({ error: 'Handler error' }, { status: 500 }); }
return NextResponse.json({ received: true }); }
// ── Helpers ──────────────────────────────────────────────────────────────────
async function upsert( userEmail: string, plan: string, inspectionsLimit: number | null, stripeCustomerId: string, stripeSubscriptionId: string, ) { await db.query( 'INSERT INTO subscriptions (user_email, plan, inspections_limit, stripe_customer_id, stripe_subscription_id, current_period_start, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) ON CONFLICT (user_email) DO UPDATE SET plan = EXCLUDED.plan, inspections_limit = EXCLUDED.inspections_limit, stripe_customer_id = EXCLUDED.stripe_customer_id, stripe_subscription_id = EXCLUDED.stripe_subscription_id, current_period_start = EXCLUDED.current_period_start, updated_at = NOW()', [userEmail, plan, inspectionsLimit, stripeCustomerId, stripeSubscriptionId], ); }
async function getPriceIdFromSubscription(subscriptionId: string): Promise<string | null> { try { const sub = await stripe.subscriptions.retrieve(subscriptionId); return sub.items.data[0]?.price?.id ?? null; } catch { return null; } }
async function getEmailFromCustomer(customerId: string): Promise<string | null> { // Check our DB first (fast path) const res = await db.query( 'SELECT user_email FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1', [customerId], ); if (res.rows[0]) return res.rows[0].user_email;

// Fall back to Stripe customer object 
try { const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer; return customer.email ?? null; } catch { return null; } }