import { h } from "preact";

// Read from manifest at build time - esbuild injects it via define
declare const __EXT_VERSION__: string;

export function Disclaimer({ host }: { host: string | null }) {
  const version = typeof __EXT_VERSION__ !== "undefined"
    ? __EXT_VERSION__
    : "dev";
  const gitHubUrl = `https://github.com/dafky2000/seelevel`;
  const issueUrl =
    `${gitHubUrl}/issues/new?labels=bug&template=bug_report.md&body=%0A%0A**Extension+version:**+${version}`;

  const isViewPoint = host !== null &&
    (host === "viewpoint.ca" || host.endsWith(".viewpoint.ca"));
  const isEV = host === "engelvoelkersnovascotia.com";

  // Off a supported site there is nothing to credit or disclaim - hide it.
  if (!isViewPoint && !isEV) return null;

  const bodyText: h.JSX.Element = isViewPoint
    ? (
      <>
        The SeeLevel extension is for personal use only. This extension
        processes data your browser receives from ViewPoint.ca and does not
        store, transmit, or redistribute listing or telemetry data. Data Source:
        ViewPoint Realty, NSAR MLS® System and Province of Nova Scotia.
      </>
    )
    : (
      <>
        The SeeLevel extension is for personal use only. This extension
        processes data your browser receives from engelvoelkersnovascotia.com,
        plus one small filtered request per map move (pan/zoom), using your
        existing session. Nothing is stored, transmitted off-device, or
        redistributed. Data Source: Engel &amp; Völkers Nova Scotia and NSAR
        MLS® System.
      </>
    );

  return (
    <div class="seelevel-disclaimer">
      {bodyText}{" "}
      The source code for this extension is available on GitHub for review at
      {" "}
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
