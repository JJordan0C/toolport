import { Globe, Terminal } from "lucide-react";
import { cn } from "@/lib/utils";
import { serverLogoKey } from "@/lib/serverLogo";

const RAW = import.meta.glob("../assets/server-logos/*.svg", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const LOGOS: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, svg]) => [
    path.split("/").pop()!.replace(".svg", ""),
    // The surrounding element is decorative. Remove the source title so it
    // does not become a second accessible copy of the adjacent server name.
    svg.replace(/<title>.*?<\/title>/i, ""),
  ]),
);

/** A local provider mark for known servers, with a neutral transport fallback. */
export function ServerLogo({
  name,
  transport,
  size = 28,
  className,
}: {
  name: string;
  transport: string;
  size?: number;
  className?: string;
}) {
  const key = serverLogoKey(name);
  const svg = key ? LOGOS[key] : null;

  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-black/10 bg-white/90 p-1.5 text-muted-foreground",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {svg ? (
        <span
          className="inline-flex size-full items-center justify-center [&>svg]:size-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      ) : transport === "stdio" ? (
        <Terminal className="size-full" />
      ) : (
        <Globe className="size-full" />
      )}
    </span>
  );
}
