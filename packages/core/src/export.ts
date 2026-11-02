export type ExportFormat = "hosts" | "domains" | "dnsmasq" | "unbound";

export const EXPORT_FORMATS: ExportFormat[] = ["hosts", "domains", "dnsmasq", "unbound"];

/**
 * The merged selection in a format another blocker understands (a router,
 * Pi-hole, a local resolver). One entry per line, LF line endings.
 */
export function exportList(hosts: string[], format: ExportFormat, ip = "0.0.0.0", header?: string): string {
  const head = header ? header.split("\n").map((l) => `# ${l}`).join("\n") + "\n" : "";
  switch (format) {
    case "hosts":
      return head + hosts.map((h) => `${ip} ${h}`).join("\n") + "\n";
    case "domains":
      return head + hosts.join("\n") + "\n";
    case "dnsmasq":
      // note: dnsmasq address=/x/ also matches subdomains of x
      return head + hosts.map((h) => `address=/${h}/${ip}`).join("\n") + "\n";
    case "unbound":
      return head + "server:\n" + hosts.map((h) => `  local-zone: "${h}." always_null`).join("\n") + "\n";
  }
}
