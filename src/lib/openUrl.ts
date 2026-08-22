import { invoke } from "@tauri-apps/api/core";

/**
 * Open an external link, but only real web URLs.
 *
 * Some of these URLs originate from registry/vendor data (a catalog entry's
 * homepage, an auth hint's docs link), which is not fully trusted. Handing a
 * `file://` (Windows SMB -> NTLM-hash leak) or a custom-scheme handler URI to
 * the OS opener is a real risk, so allow only `http`/`https` through. The
 * backend also validates at the source (see `catalog.rs`), and the `open_external`
 * command re-checks on the IPC boundary; this is the matching frontend guard so
 * every call site is covered.
 *
 * Goes through our own `open_external` command rather than
 * `tauri-plugin-opener`: the plugin spawns the browser with whatever environment
 * we inherited, and under an AppImage that means the bundle's library paths, so
 * the browser dies on `undefined symbol` and the link silently never opens
 * (see `hostenv.rs`).
 *
 * Link-local and metadata-range hosts are refused too: clicking "docs" on an
 * untrusted registry entry must not reach `http://169.254.169.254/…` (IMDSv1)
 * from a cloud desktop. Loopback stays allowed for locally served docs; other
 * private LAN ranges are ordinary browsing and stay allowed as well.
 *
 * Silently no-ops on a missing or refused URL rather than throwing, since these
 * are all fire-and-forget click handlers.
 */
export function openExternal(url: string | null | undefined): Promise<void> {
  if (!url) return Promise.resolve();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn(`openExternal: refusing to open unparseable URL: ${url}`);
    return Promise.resolve();
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.warn(`openExternal: refusing to open non-web URL: ${url}`);
    return Promise.resolve();
  }
  if (isLinkLocalHost(parsed.hostname)) {
    console.warn(`openExternal: refusing to open link-local/metadata URL: ${url}`);
    return Promise.resolve();
  }
  return invoke<void>("open_external", { url }).catch((error: unknown) => {
    console.warn(`openExternal: could not open ${url}: ${String(error)}`);
  });
}

/** Link-local and metadata address ranges only — deliberately narrower than
 * `isPrivateHostUrl` (ImportReviewDialog): loopback and RFC1918 LAN hosts are
 * legitimate browser targets, the metadata ranges never are. */
function isLinkLocalHost(hostname: string): boolean {
  // WHATWG keeps a trailing dot on named hosts and brackets on IPv6 literals.
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  // Well-known metadata hostnames resolve to the metadata service without a
  // link-local literal ever appearing in the URL. A renderer can't do DNS, so
  // match the names directly (mirrors oauth.rs `ip_is_link_local`'s intent).
  if (host === "metadata.google.internal" || host === "metadata") return true;
  const v4 = (dotted: string): boolean => {
    const match = dotted.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const [a, b, c, d] = match.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return false;
    return (
      (a === 169 && b === 254) || // link-local, incl. 169.254.169.254 (IMDS)
      (a === 100 && (b & 0xc0) === 64) || // CGNAT 100.64/10 (Alibaba/OCI metadata)
      a === 0 || // "this network" — 0.0.0.0 reaches loopback/IMDS on some stacks
      (a === 255 && b === 255 && c === 255 && d === 255) // broadcast
    );
  };
  if (!host.includes(":")) return v4(host);
  // IPv4-mapped IPv6 — WHATWG may emit dotted or hex form.
  const mappedDotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mappedDotted) return v4(mappedDotted[1]);
  const mappedHex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return v4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  if (host === "::" || host === "0:0:0:0:0:0:0:0") return true; // unspecified
  // AWS IMDS on IPv6 (same service as 169.254.169.254; oauth.rs treats it as
  // link-local too).
  if (host === "fd00:ec2::254") return true;
  const first = parseInt(host.split(":")[0] || "0", 16);
  if (Number.isNaN(first)) return false;
  return (first & 0xffc0) === 0xfe80; // fe80::/10 link-local
}
