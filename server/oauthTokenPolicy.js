'use strict';
const ACCESS_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Historical OAuth rows were minted with this fixed issuer label. Bind them using
// refresh metadata first; a unique exact legacy issuer label is the fallback.
async function backfill(query, { dryRun = false } = {}) {
  const tokens = await query("SELECT id, name, workspace_id, lead_id, created_at FROM workspace_tokens WHERE expires_at IS NULL AND name LIKE 'Claude OAuth · %'");
  if (!tokens.length) return { legacy: 0, bound: 0, expired: 0 };
  const refresh = await query('SELECT payload_json FROM mcp_oauth_refresh_tokens');
  const metadata = refresh.flatMap(row => { try { return [JSON.parse(row.payload_json)]; } catch { return []; } });
  let bound = 0, expired = 0;
  for (const token of tokens) {
    const emails = [...new Set(metadata.filter(m => Number(m.tokenId) === Number(token.id)
      && Number(m.workspaceId) === Number(token.workspace_id) && Number(m.leadId) === Number(token.lead_id))
      .map(m => String(m.email || '').trim().toLowerCase()).filter(Boolean))];
    let users = emails.length === 1 ? await query(`SELECT id, status FROM client_portal_users
      WHERE email = :email AND workspace_id = :workspaceId AND lead_id = :leadId`,
      { email: emails[0], workspaceId: token.workspace_id, leadId: token.lead_id }) : [];
    if (emails.length === 0) {
      const candidates = await query(`SELECT id, email, status FROM client_portal_users
        WHERE workspace_id = :workspaceId AND lead_id = :leadId`,
        { workspaceId: token.workspace_id, leadId: token.lead_id });
      users = candidates.filter(u => token.name === `Claude OAuth · ${String(u.email || '').slice(0, 36)} · lead ${token.lead_id}`);
    }
    const rawCreated = String(token.created_at || '').replace(' ', 'T');
    const created = token.created_at instanceof Date ? token.created_at.getTime()
      : Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/.test(rawCreated) ? rawCreated : rawCreated + 'Z');
    const user = users.length === 1 && users[0].status === 'active' ? users[0] : null;
    const expiresAt = user && Number.isFinite(created) ? created + ACCESS_TTL_MS : 0;
    const oauthUserId = user ? Number(user.id) : null;
    if (expiresAt > Date.now()) bound++; else expired++;
    if (!dryRun) await query(`UPDATE workspace_tokens SET expires_at = :expiresAt, oauth_user_id = :oauthUserId
      WHERE id = :id AND expires_at IS NULL`, { id: token.id, expiresAt, oauthUserId });
  }
  return { legacy: tokens.length, bound, expired };
}
module.exports = { ACCESS_TTL_MS, backfill };
