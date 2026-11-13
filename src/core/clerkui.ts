import type { ClerkAuth } from "./clerk.js";

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** What a page needs to show Clerk's sign-in. */
export interface ClerkPage {
  publishableKey: string;
  scriptUrl: string;
  uiScriptUrl: string;
  frontendApi: string;
}

export function clerkPage(clerk: ClerkAuth): ClerkPage {
  return { publishableKey: clerk.publishableKey, scriptUrl: clerk.scriptUrl, uiScriptUrl: clerk.uiScriptUrl, frontendApi: clerk.frontendApi };
}

/** Content-Security-Policy for a page that runs Clerk's browser SDK (per Clerk's CSP guidance). */
export function clerkCsp(frontendApi: string, extra = ""): string {
  const fapi = `https://${frontendApi}`;
  return [
    "default-src 'none'",
    `script-src 'self' ${fapi} https://challenges.cloudflare.com https://cdn.protect.clerk.com https://*.protect.clerk.com`,
    `connect-src 'self' ${fapi} https://cdn.protect.clerk.com https://*.protect.clerk.com:*`,
    "img-src 'self' https://img.clerk.com https: data:",
    "style-src 'unsafe-inline'",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    ...(extra ? [extra] : []),
  ].join("; ");
}

/** The script tags that load Clerk and the small sign-in helper below. */
export function clerkScripts(page: ClerkPage, opts: { mode: "login" | "consent"; form: string; signOut?: boolean }): string {
  return `<div id="clerk-signin" data-mode="${opts.mode}" data-form="${esc(opts.form)}"${opts.signOut ? ' data-sign-out="1"' : ""} hidden></div>
<script id="clerk-ui-script" async crossorigin="anonymous" src="${esc(page.uiScriptUrl)}"></script>
<script id="clerk-script" async crossorigin="anonymous" data-clerk-publishable-key="${esc(page.publishableKey)}" src="${esc(page.scriptUrl)}"></script>
<script src="/assets/clerk-signin.js" defer></script>`;
}

/**
 * Browser helper served at /assets/clerk-signin.js. It shows Clerk's sign-in, then
 * posts a fresh Clerk session token with the page's form so the server can check it.
 * Login pages submit straight away; the consent page waits for Allow.
 */
export const CLERK_SIGNIN_JS = `(() => {
  const cfg = document.getElementById("clerk-signin");
  if (!cfg) return;
  const form = document.getElementById(cfg.dataset.form);
  const mount = document.getElementById("clerk-mount");
  const status = document.getElementById("clerk-status");
  const who = document.getElementById("clerk-who");
  const allow = form.querySelector('button[value="allow"]');
  const other = document.getElementById("clerk-other");
  const tokenInput = form.querySelector('input[name="clerk_token"]');
  const script = document.getElementById("clerk-script");
  const uiScript = document.getElementById("clerk-ui-script");
  let busy = false;
  const show = (msg) => { status.textContent = msg; status.hidden = false; };
  const waitFor = (el, get) => new Promise((resolve, reject) => {
    if (get()) return resolve(get());
    el.addEventListener("load", () => (get() ? resolve(get()) : reject(new Error("missing after load"))));
    el.addEventListener("error", () => reject(new Error("load failed")));
  });
  const loaded = () => Promise.all([
    waitFor(script, () => window.Clerk),
    waitFor(uiScript, () => window.__internal_ClerkUICtor),
  ]);
  const submit = async (clerk) => {
    if (busy) return;
    busy = true;
    try {
      tokenInput.value = await clerk.session.getToken();
      form.submit();
    } catch (e) {
      busy = false;
      show("Could not finish signing in. Reload the page and try again.");
    }
  };
  const signedIn = (clerk) => {
    mount.hidden = true;
    if (who) {
      who.textContent = (clerk.user.primaryEmailAddress && clerk.user.primaryEmailAddress.emailAddress) || "your account";
      who.parentElement.hidden = false;
    }
    if (allow) allow.disabled = false;
    if (cfg.dataset.mode === "login") submit(clerk);
  };
  form.addEventListener("submit", (e) => {
    const decision = e.submitter && e.submitter.value;
    if (decision === "deny") return;
    e.preventDefault();
    if (!window.Clerk || !window.Clerk.session) return show("Sign in first.");
    const hidden = document.createElement("input");
    hidden.type = "hidden"; hidden.name = "decision"; hidden.value = "allow";
    form.appendChild(hidden);
    submit(window.Clerk);
  });
  if (other) other.addEventListener("click", async () => {
    if (window.Clerk) await window.Clerk.signOut();
    location.reload();
  });
  loaded().then(async ([clerk, ClerkUI]) => {
    await clerk.load({ ui: { ClerkUI } });
    if (cfg.dataset.signOut === "1" && clerk.user) await clerk.signOut();
    if (clerk.user && clerk.session) return signedIn(clerk);
    let done = false;
    clerk.addListener((state) => {
      if (!done && state.user && state.session) { done = true; signedIn(clerk); }
    });
    clerk.mountSignIn(mount, {
      forceRedirectUrl: location.href,
      signUpForceRedirectUrl: location.href,
      // Fit inside the page's own card, down to phone widths.
      appearance: { elements: { rootBox: { width: "100%" }, cardBox: { width: "100%", maxWidth: "100%", boxShadow: "none", border: "1px solid rgba(0,0,0,0.08)" } } },
    });
  }).catch((e) => { console.error("Agent Brain sign-in", e); show("Sign-in could not load. Check your connection and reload the page."); });
})();
`;
