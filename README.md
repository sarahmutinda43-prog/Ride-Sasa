# Ride Sasa

A Kenyan car marketplace with manual vehicle listings, dealer accounts and a public catalog. Listings are currently free and unlimited. The frontend is plain HTML, CSS and JavaScript; account and listing APIs run in a Cloudflare Worker backed by D1.

## Local preview

Open `index.html` to view the catalog. Without the Worker and D1 database, the catalog stays empty and displays an availability message rather than inventing sample vehicles. Dealer sign-in, Google OAuth, publishing and saved-listing sync require the configured backend. The Ride Sasa logo and interactive brand video are in `assets/`.

## Deploy the Worker and database

1. Install Wrangler and sign in to the Cloudflare account that owns the Worker:

   ```powershell
   npm install --global wrangler
   wrangler login
   ```

2. Create the D1 database and replace `REPLACE_WITH_CLOUDFLARE_D1_DATABASE_ID` in `wrangler.toml` with the ID returned by Cloudflare:

   ```powershell
   wrangler d1 create ride-sasa
   ```

3. Apply all migrations, including the full-text search and catalog indexes:

   ```powershell
   wrangler d1 migrations apply ride-sasa --remote
   ```

4. Create a Google OAuth **Web application** client in Google Cloud Console. Set the authorized redirect URI to the exact production URL:

   ```text
   https://ride-sasa.sarahmutinda43.workers.dev/api/auth/google/callback
   ```

   If using a custom domain, use that domain instead. Set `GOOGLE_CLIENT_ID` as a Worker variable and add the client secret without pasting it into source code or chat:

   ```powershell
   wrangler secret put GOOGLE_CLIENT_SECRET
   ```

   Google OAuth consent must be configured and the account used for testing must be an allowed test user until the OAuth app is published. The owner/admin email is `antoniokinyua4@gmail.com`; admin access is Google-only and checked by the Worker.

5. Deploy the Worker and static assets from this directory:

   ```powershell
   wrangler deploy
   ```

   Verify that `https://<worker-domain>/api/health` returns JSON with `ok: true`, then open `/dealer.html` and test Google sign-in. If `/api/health` returns the catalog HTML instead of JSON, the request is not reaching the current Worker deployment. The production dashboard must show the `DB` D1 binding.

Dealers can create accounts with Google or email/password and manually add, edit and archive unlimited units at no cost. There are no trials, subscriptions, listing fees or expiry dates. The dealer listing form stores image URLs; image files are not stored in D1.

Older D1 databases may retain unused payment tables and subscription columns to preserve existing records. The Worker no longer exposes billing or payment-webhook endpoints. Remove any previously configured `PAYSTACK_SECRET_KEY` from Cloudflare.

## Catalog capacity

Public search uses FTS5, indexed filters and keyset pagination so each catalog request returns at most 24 listings instead of loading the whole database into the browser. Dealer inventory history is also paginated. Public reads use D1 Sessions so they can benefit from read replicas when replication is enabled for the database in Cloudflare.

D1 is not unlimited: Cloudflare currently documents a maximum database size of 10 GB on Workers Paid and 500 MB on Free; a single D1 database processes queries serially. Enable D1 read replication for higher read throughput. For a marketplace that outgrows one database's storage or write throughput, plan a sharded or managed-SQL architecture before reaching that limit. Keep vehicle photos in image hosting or R2 and store only their HTTPS URLs in D1.

## Advertising revenue

The public catalog includes two responsive Google AdSense placements. To activate them:

1. Apply for and get approval for a Google AdSense account and website.
2. In `index.html`, set the `google-adsense-account` meta tag to your publisher ID (`ca-pub-...`).
3. Replace the two `REPLACE_WITH_*_AD_SLOT_ID` values with the ad-unit IDs from AdSense.
4. Deploy the site and follow Google's site, privacy and consent requirements.

Ad placements stay hidden until valid publisher and ad-unit IDs are configured. Ad approval and earnings are controlled by Google and are not guaranteed.
