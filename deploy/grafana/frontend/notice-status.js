/* Keep Grafana's built-in Markdown notices truthful when query-variable refresh fails.
 * This owned static asset observes requests; upstream errors still reach Grafana. */
(() => {
  const states = new Map();
  const titles = { time_range: "Time range notice", excluded_runs: "Excluded runs" };
  let scheduled = false;
  function render() {
    scheduled = false;
    for (const [kind, state] of states) {
      for (const region of document.querySelectorAll(
        '[role="region"], section[aria-label], section[aria-labelledby]'
      )) {
        if (
          (
            region.getAttribute("aria-label") ??
            region.querySelector('h2, [role="heading"]')?.textContent
          )?.trim() !== titles[kind]
        )
          continue;
        let status = region.querySelector(".parkbench-notice-status");
        const unavailable = state.phase !== "ready";
        for (const paragraph of region.querySelectorAll("p")) {
          if (paragraph.hidden !== unavailable) paragraph.hidden = unavailable;
        }
        if (unavailable) {
          if (!status) {
            status = document.createElement("div");
            status.className = "parkbench-notice-status";
            status.setAttribute("role", "status");
            region.append(status);
          }
          const message =
            state.phase === "failed"
              ? "Notice unavailable: refresh failed. Refresh the dashboard to retry."
              : "Checking the current notice…";
          if (status.textContent !== message) status.textContent = message;
        } else if (status) status.remove();
      }
    }
  }
  function schedule() {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(render);
    }
  }
  function begin(url, body) {
    let text = String(url) + " " + String(body ?? "");
    try {
      text = decodeURIComponent(text);
    } catch {}
    if (!text.includes("parkbench_run_notice_text")) return [];
    const kinds = Object.keys(titles).filter((kind) => text.includes(kind));
    return (kinds.length ? kinds : Object.keys(titles)).map((kind) => {
      const token = {};
      states.set(kind, { token, phase: "checking" });
      schedule();
      return { kind, token };
    });
  }
  function finish(requests, successful) {
    for (const { kind, token } of requests) {
      if (states.get(kind)?.token !== token) continue;
      states.set(kind, { token, phase: successful ? "ready" : "failed" });
    }
    schedule();
  }
  const fetchOriginal = window.fetch;
  window.fetch = async function (input, options) {
    let body = options?.body;
    if (input instanceof Request && body === undefined) {
      try {
        body = await input.clone().text();
      } catch {}
    }
    const requests = begin(typeof input === "string" ? input : (input.url ?? String(input)), body);
    try {
      const response = await fetchOriginal.apply(this, arguments);
      if (requests.length) {
        let success = response.ok;
        if (success) {
          try {
            const body = await response.clone().json();
            success =
              body.status !== "error" &&
              !body.error &&
              !Object.values(body.results ?? {}).some((result) => result.error);
          } catch {
            success = false;
          }
        }
        finish(requests, success);
      }
      return response;
    } catch (error) {
      finish(requests, false);
      throw error;
    }
  };
  const openOriginal = XMLHttpRequest.prototype.open;
  const sendOriginal = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url) {
    urls.set(this, url);
    return openOriginal.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const requests = begin(urls.get(this), body);
    if (requests.length)
      this.addEventListener(
        "loadend",
        () => {
          let success = this.status >= 200 && this.status < 300;
          try {
            const result =
              this.responseType === "json" ? this.response : JSON.parse(this.responseText);
            success =
              success &&
              result.status !== "error" &&
              !result.error &&
              !Object.values(result.results ?? {}).some((value) => value.error);
          } catch {
            success = false;
          }
          finish(requests, success);
        },
        { once: true }
      );
    return sendOriginal.apply(this, arguments);
  };
  new MutationObserver(schedule).observe(document.documentElement, {
    childList: true,
    subtree: true
  });
})();
