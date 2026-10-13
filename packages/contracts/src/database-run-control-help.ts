/** Browser-safe operator help; runtime control validation stays in database-run-controls.ts. */
export const DATABASE_RUN_CONTROL_HELP = {
  "database.apwCount": {
    description: "Background writers that flush changed database blocks",
    explanation:
      "Asynchronous page writers write changed database blocks from memory to disk in the background. This can reduce the writing that application processes must do themselves and help clear changed buffers before checkpoints. More writers use additional resources; the useful number depends on the update workload.",
    minimum: 0,
    maximum: 9,
    defaultValue: 0,
    unit: "writers",
    documentation: [
      {
        url: "https://docs.progress.com/bundle/openedge-database-management-128/page/Start-and-stop-an-APW.html",
        version: "12.8"
      }
    ]
  },
  "database.biClusterSizeMiB": {
    description: "Size of each before-image recovery-log cluster in MiB",
    explanation:
      "The before-image recovery log is organized into clusters that can be reused once their recovery information is no longer needed. This setting changes the size of each cluster, affecting how much BI information it holds before the log advances to another cluster. It is different from a BI block's size and from the total BI file size.",
    minimum: 0.015625,
    maximum: 255.984375,
    defaultValue: 0.5,
    unit: "MiB",
    documentation: [
      {
        url: "https://docs.progress.com/bundle/openedge-database-management-128/page/PROUTIL-TRUNCATE-BI-qualifier.html",
        version: "12.8"
      }
    ]
  },
  "database.biwEnabled": {
    description: "Background writer for before-image recovery notes",
    explanation:
      "A before-image writer writes buffered recovery notes to the BI file in the background. It helps move that writing work away from processes updating the database. Enable this setting to run one BIW; disabling it starts no BIW. The BI buffer count is a separate setting.",
    minimum: false,
    maximum: true,
    defaultValue: false,
    documentation: [
      {
        url: "https://docs.progress.com/bundle/openedge-database-management-128/page/Start-and-stop-a-BIW.html",
        version: "12.8"
      }
    ]
  }
} as const;
