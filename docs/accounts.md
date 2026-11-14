# Accounts and sign-in

Agent Brain can serve several people, each with their own projects and brains. People sign in through [Clerk](https://clerk.com); Agent Brain remains the OAuth server that ChatGPT, Claude and other MCP clients connect to, so dynamic registration, client ID metadata documents, PKCE and `private_key_jwt` all keep working.

Without Clerk settings, an instance has a single owner who signs in with `OWNER_EMAIL` and `OWNER_PASSWORD` (see [self-hosting](self-hosting.md)).

## How it works

- The website's `/login` page and the OAuth consent page at `/authorize` show Clerk's sign-in. Once signed in, the browser sends a short-lived Clerk session token with the form; the server checks its signature against the instance's keys, its issuer, expiry and the `azp` origin (which must be `PUBLIC_URL`), then reads the person from Clerk's Backend API.
- Each Clerk user maps to one Agent Brain account. The account is found by Clerk user ID, then by verified primary email, and is otherwise created empty. Matching by email links an existing account (such as the original owner's) the first time that person signs in with Clerk, and keeps it linked if the instance ever moves to another Clerk instance.
- Every project, brain, image, OAuth grant, API key, website session and event subscription belongs to one account. There is no sharing between accounts.
- Using a project token or brain reference that belongs to another account gives a `forbidden` error that says so: an MCP tool error with code `forbidden`, or a 403 page on the website. Tokens and references that do not exist are still `not_found`.
- With Clerk configured, password sign-in is off.

## Adding and removing people

Sign-up is by invitation only (Clerk's restricted sign-up mode). In the [Clerk dashboard](https://dashboard.clerk.com), open the Agent Brain application, then **Users → Create user** or **Invite**. The person signs in at the instance's address with their email; their account starts empty.

To remove someone, delete, ban or lock them in Clerk. Agent Brain re-checks each linked account with Clerk at most every 15 minutes, so their website sessions and agent connections stop working within that time. If Clerk cannot be reached, the last known status stands. Their data stays in Agent Brain; if the same email is invited again, the account is linked again.

## Setting it up

1. Create a Clerk application with email sign-in and set sign-up to **Restricted**. For a public domain, create its production instance and add the DNS records Clerk lists.
2. Set the keys as secrets, never in the repository:

   ```sh
   npx wrangler secret put CLERK_PUBLISHABLE_KEY   # pk_live_... or pk_test_...
   npx wrangler secret put CLERK_SECRET_KEY        # sk_live_... or sk_test_...
   ```

   In Docker, set the same two variables. Set both or neither.
3. Set `OWNER_EMAIL` to the email the owner uses in Clerk (and add that email in Clerk) so existing data is linked to them on first sign-in. Changing `OWNER_EMAIL` moves the existing owner account to the new address rather than starting an empty one. `OWNER_PASSWORD` is no longer used for sign-in once Clerk is on.

The sign-in pages load Clerk's browser SDK from the instance's Frontend API, with a Content Security Policy limited to Clerk's hosts. Every other page still has no JavaScript.
