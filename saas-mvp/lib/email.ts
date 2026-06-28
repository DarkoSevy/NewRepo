import { Resend } from "resend";

export const resend = new Resend(process.env.RESEND_API_KEY);

const FROM = process.env.EMAIL_FROM ?? "NexusHub <no-reply@nexushub.com>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

export async function sendInvitationEmail({
  to,
  inviterName,
  organizationName,
  token,
}: {
  to: string;
  inviterName: string;
  organizationName: string;
  token: string;
}) {
  const url = `${APP_URL}/invite/${token}`;

  return resend.emails.send({
    from: FROM,
    to,
    subject: `${inviterName} invited you to ${organizationName} on NexusHub`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#6366f1">You're invited!</h1>
        <p><strong>${inviterName}</strong> has invited you to join <strong>${organizationName}</strong> on NexusHub.</p>
        <a href="${url}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;margin:16px 0">
          Accept Invitation
        </a>
        <p style="color:#6b7280;font-size:14px">This invitation expires in 7 days. If you didn't expect this, you can ignore this email.</p>
      </div>
    `,
  });
}

export async function sendWelcomeEmail({
  to,
  name,
}: {
  to: string;
  name: string;
}) {
  return resend.emails.send({
    from: FROM,
    to,
    subject: "Welcome to NexusHub!",
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#6366f1">Welcome, ${name}!</h1>
        <p>Your account is ready. Start by creating your first project.</p>
        <a href="${APP_URL}/dashboard" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;margin:16px 0">
          Go to Dashboard
        </a>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({
  to,
  token,
}: {
  to: string;
  token: string;
}) {
  const url = `${APP_URL}/reset-password?token=${token}`;

  return resend.emails.send({
    from: FROM,
    to,
    subject: "Reset your NexusHub password",
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h1 style="color:#6366f1">Reset your password</h1>
        <p>Click the button below to reset your password. This link expires in 1 hour.</p>
        <a href="${url}" style="display:inline-block;background:#6366f1;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;margin:16px 0">
          Reset Password
        </a>
        <p style="color:#6b7280;font-size:14px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
  });
}
