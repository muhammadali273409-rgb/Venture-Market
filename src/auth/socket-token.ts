/**
 * Short-lived token for the Socket.IO handshake (`/realtime` namespace).
 *
 * The browser can't use its access token for this: that token is an
 * httpOnly cookie, and in production it lives on the frontend's domain
 * (re-issued by its same-origin proxy), so neither JS nor a cross-site
 * WebSocket handshake to this API can read or send it. Instead the frontend
 * fetches one of these through its proxy (cookie-authenticated) and passes
 * it in `handshake.auth.token`.
 *
 * Signed with the same secret as access tokens, so it carries `typ` and
 * JwtStrategy refuses it — it can open a socket, never call the REST API.
 */
export const SOCKET_TOKEN_TYPE = 'socket';
export const SOCKET_TOKEN_TTL = '2m';

export interface SocketTokenPayload {
  sub: string;
  typ: typeof SOCKET_TOKEN_TYPE;
}
