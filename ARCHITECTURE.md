# Architecture and decisions

The browser loads CSS and the bootstrap module, establishes a fresh memory-only storage object, seeds an invented profile and 28 transactions, then dynamically imports the application. Original persistent storage is never read by the bootstrap. Unsupported isolation fails closed.

Hash routing exposes Today, Reports, Badges and adapted demo Settings. The retained ledger logic computes transaction-native currency and converts amounts for display, preserving stored native values. Mutations recompute daily aggregates. UI translations are bundled locally. Recharts renders report groupings from the in-memory ledger.

Retained cloud call sites use a disconnected compatibility facade. It imports no SDK, endpoint, environment configuration or credential; authentication returns null, and query/write/function chains resolve denied. Original production authentication/admin routes, migrations, integrations, assets and privileged services are absent. A `connect-src 'none'` content policy independently rejects browser connections. The public candidate ships no server.

CSV export reads only the current memory ledger. It quotes text, escapes quotes/newlines, neutralizes formula-like text cells, includes native currency, and downloads through a local Blob URL. It deliberately replaces inherited XLSX export and does not imply a cloud reporting feature. Changing report range does not filter this complete-ledger download.

Memory-only operation sacrifices persistence and realistic cloud-sync behavior to create a repeatable employer demonstration. Reload creates a new seed. There is no runtime switch that reconnects production. This extract demonstrates interface/ledger choices; cloud reliability remains a separate original-project engineering story requiring evidence and permission.

CSS discovery is restricted explicitly to the selected source directory and entry HTML using Tailwind source directives. Documentation and neighboring projects are not scanned for classes. Report bar animation is disabled so the chart renders its complete values immediately, including in background previews.
