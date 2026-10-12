import { EmailMessage } from './email-provider.interface';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(heading: string, paragraphs: string[], action?: { label: string; link: string }) {
  const body = paragraphs.map((p) => `<p style="margin:0 0 12px">${escapeHtml(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:20px 0"><a href="${escapeHtml(action.link)}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action.label)}</a></p>
       <p style="margin:0;color:#6b7280;font-size:12px;word-break:break-all">${escapeHtml(action.link)}</p>`
    : '';
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;color:#0a0a0a;background:#f6f7f9;padding:24px">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>${body}${button}
<p style="margin:24px 0 0;color:#9ca3af;font-size:12px">VentureMarket</p></div></body></html>`;
}

/** Tajik first (the primary audience), English below. */
export function renderEmail(message: EmailMessage): RenderedEmail {
  const v = message.variables;
  switch (message.template) {
    case 'verification': {
      const paragraphs = [
        'Барои тасдиқи почтаи худ тугмаи зеринро пахш кунед. Истинод 24 соат эътибор дорад.',
        'Please confirm your email address. The link is valid for 24 hours.',
      ];
      return {
        subject: message.subject,
        html: layout('Почтаи худро тасдиқ кунед', paragraphs, {
          label: 'Тасдиқ / Verify',
          link: v.link,
        }),
        text: `${paragraphs.join('\n\n')}\n\n${v.link}`,
      };
    }
    case 'password-reset': {
      const paragraphs = [
        'Барои гузоштани пароли нав тугмаи зеринро пахш кунед. Агар шумо инро напурсида бошед, ин паёмро сарфи назар кунед.',
        "Use the button below to set a new password. If you didn't request this, ignore this email.",
      ];
      return {
        subject: message.subject,
        html: layout('Барқарор кардани парол', paragraphs, {
          label: 'Пароли нав / Reset',
          link: v.link,
        }),
        text: `${paragraphs.join('\n\n')}\n\n${v.link}`,
      };
    }
    default: {
      const paragraphs = [
        v.body,
        ...Object.entries(v)
          .filter(([k]) => k !== 'body' && k !== 'title')
          .map(([, val]) => val),
      ].filter((p): p is string => Boolean(p));
      return {
        subject: message.subject,
        html: layout(v.title ?? message.subject, paragraphs),
        text: paragraphs.join('\n\n') || message.subject,
      };
    }
  }
}

/** "VentureMarket <noreply@x.com>" → { name, email }. */
export function parseFromAddress(from: string): { name?: string; email: string } {
  const match = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(from);
  if (!match) return { email: from.trim() };
  return { name: match[1] || undefined, email: match[2].trim() };
}
