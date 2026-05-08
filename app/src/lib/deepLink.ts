// Parser for the `touchgrass://` URL scheme. The daemon's ntfy `Click` header
// uses two shapes:
//
//   touchgrass://sessions/<id>                       (session-complete pings)
//   touchgrass://sessions/<id>?permission=<req_id>   (permission requests)
//
// Both resolve to the Chat screen for `<id>`; the permission flavour also
// pre-opens the modal for `<req_id>`.

export interface ParsedDeepLink {
  sessionId: string;
  permissionId?: string;
}

export function parseDeepLink(url: string | null | undefined): ParsedDeepLink | null {
  if (!url) return null;
  const match = url.match(
    /^touchgrass:\/\/sessions\/([^/?#]+)(?:\?(.*))?$/i,
  );
  if (!match) return null;
  const sessionId = decodeURIComponent(match[1]);
  if (!sessionId) return null;
  const query = match[2];
  let permissionId: string | undefined;
  if (query) {
    for (const part of query.split("&")) {
      const [k, v] = part.split("=");
      if (k === "permission" && v) permissionId = decodeURIComponent(v);
    }
  }
  return { sessionId, permissionId };
}
