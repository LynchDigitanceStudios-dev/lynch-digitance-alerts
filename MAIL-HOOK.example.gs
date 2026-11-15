/**
 * MAIL-HOOK.gs  — lets the admin page email your extension users through YOUR Gmail.
 *
 * Setup (about 3 minutes):
 *  1. Go to script.google.com while signed in to the Gmail you want mail to come from → New project.
 *  2. Paste this whole file over the default code.
 *  3. Change SECRET below to a long random string (anything; keep it private).
 *  4. Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy.
 *     Approve the permission prompt (it needs to send mail as you).
 *  5. Copy the Web app URL and the SECRET and give them to Claude, who stores them as Worker secrets.
 *
 * Limits: a normal Gmail sends about 100 recipients a day (Workspace: 1,500). The Worker sends in
 * batches of 40; anything over your daily quota comes back as "failed" in the admin page.
 */
const SECRET = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    if (d.secret !== SECRET) return out({ ok: false, error: 'forbidden' });
    let sent = 0;
    (d.to || []).slice(0, 40).forEach(function (addr) {
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) return;
      MailApp.sendEmail({ to: addr, subject: String(d.subject).slice(0, 150), body: String(d.text).slice(0, 6000), name: 'Lynch Digitance Alerts' });
      sent++;
    });
    return out({ ok: true, sent: sent });
  } catch (err) {
    return out({ ok: false, error: String(err) });
  }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
