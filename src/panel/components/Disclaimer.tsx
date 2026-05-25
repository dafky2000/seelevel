import { h } from "preact";

// Read from manifest at build time - esbuild injects it via define
declare const __EXT_VERSION__: string;

export function Disclaimer() {
  const version = typeof __EXT_VERSION__ !== "undefined"
    ? __EXT_VERSION__
    : "dev";
  const gitHubUrl = `https://github.com/dafky2000/seelevel`;
  const issueUrl =
    `${gitHubUrl}/issues/new?labels=bug&template=bug_report.md&body=%0A%0A**Extension+version:**+${version}`;

  return (
    <div class="vpa-disclaimer">
      The SeeLevel extension is for personal use only. This extension processes
      data your browser receives from ViewPoint.ca and does not store, transmit,
      or redistribute listing or telemetry data. Data Source: ViewPoint Realty,
      NSAR MLS® System and Province of Nova Scotia. The source code for this
      extension is available on GitHub for review at{" "}
      <a
        href={gitHubUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "oklch(40% 0.02 240)" }}
      >
        {gitHubUrl}
      </a>{" "}
      -{" "}
      <a
        href={issueUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "oklch(40% 0.02 240)" }}
      >
        Report an issue
      </a>
    </div>
  );
}
