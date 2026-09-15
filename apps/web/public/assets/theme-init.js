// Apply the local preference before the first paint; no inline CSP exception.
(() => {
  let theme = "system";
  try {
    theme = localStorage.getItem("dnsmonitor-theme") || "system";
  } catch {
    /* Storage may be disabled. */
  }
  const dark =
    theme === "dark" ||
    (theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#1f1a24" : "#fdf7fd");
})();
