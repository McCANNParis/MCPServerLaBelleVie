/**
 * Server-rendered HTML for the one-time /connect/<code> page. Pure string
 * builders — no client-side JS, no external assets. The form has no `action`
 * attribute, so it always posts back to its own URL and cannot be redirected
 * elsewhere. The submitted password is never echoed back into any page.
 */

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
:root{color-scheme:light}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f4f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2a24}
.card{background:#fff;border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.08);padding:2rem;max-width:24rem;width:calc(100% - 2rem);margin:1rem}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{font-size:.9rem;line-height:1.5;color:#4a564f;margin:.5rem 0}
label{display:block;font-size:.85rem;font-weight:600;margin:1rem 0 .25rem}
input{width:100%;box-sizing:border-box;padding:.6rem .7rem;border:1px solid #c8d0cb;border-radius:8px;font-size:1rem}
button{margin-top:1.25rem;width:100%;padding:.7rem;border:0;border-radius:8px;background:#1d7a4f;color:#fff;font-size:1rem;font-weight:600;cursor:pointer}
button:hover{background:#166141}
.error{background:#fdecea;border:1px solid #f5c6c0;color:#a4372a;border-radius:8px;padding:.6rem .7rem;font-size:.85rem}
`.trim();

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main class="card">
${body}
</main>
</body>
</html>`;
}

export function renderForm(opts: { error?: string } = {}): string {
  const error = opts.error ? `<p class="error">${escapeHtml(opts.error)}</p>\n` : '';
  return page(
    'Connecter votre compte La Belle Vie',
    `<h1>Connecter votre compte La Belle Vie</h1>
<p>Ce lien à usage unique relie votre compte La Belle Vie à votre assistant. Votre mot de passe est envoyé uniquement à ce serveur — jamais à l'assistant.</p>
${error}<form method="post">
<label for="email">Email</label>
<input id="email" name="email" type="email" required autocomplete="email">
<label for="password">Mot de passe</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<button type="submit">Se connecter</button>
</form>`,
  );
}

export function renderSuccess(email: string): string {
  return page(
    'Compte connecté',
    `<h1>Compte connecté</h1>
<p>Votre compte La Belle Vie (<strong>${escapeHtml(email)}</strong>) est maintenant connecté.</p>
<p>Vous pouvez fermer cette page et retourner à votre conversation.</p>`,
  );
}

export function renderExpired(): string {
  return page(
    'Lien expiré',
    `<h1>Lien expiré ou déjà utilisé</h1>
<p>Ce lien de connexion n'est plus valide. Demandez un nouveau lien à votre assistant (outil <code>connect_account</code>).</p>`,
  );
}

export function renderLocked(): string {
  return page(
    'Trop de tentatives',
    `<h1>Trop de tentatives</h1>
<p>Ce lien a été désactivé après trop de tentatives échouées. Demandez un nouveau lien à votre assistant.</p>`,
  );
}

export function renderMisconfigured(): string {
  return page(
    'Serveur mal configuré',
    `<h1>Serveur mal configuré</h1>
<p>La clé de chiffrement des identifiants (<code>LBV_CRED_KEY</code>) n'est pas configurée sur ce serveur. Contactez l'administrateur.</p>`,
  );
}
