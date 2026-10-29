const pages = new Map([
  ["flights", "3D flights"], ["lod", "LOD"], ["paths", "Drone Paths"],
  ["simulation", "Simulation"], ["collision", "Collision"], ["credit", "Credit"],
]);
export function guidePageFromHash(hash: string) {
  const page = hash.replace(/^#\/?/, "");
  return pages.has(page) ? page : "flights";
}

// Hash routes keep both static/file builds navigable without server rewrite rules.
// Only document visibility changes; the app still owns the simulation and GPU lifetime.
export function setupGuidePages(canNavigate: () => boolean, onNavigate: () => void) {
  const links = [...document.querySelectorAll<HTMLAnchorElement>("[data-guide-page]")];
  let current = "";
  function refresh() {
    if (!canNavigate()) return;
    const page = guidePageFromHash(location.hash);
    document.body.dataset.page = page;
    document.getElementById("flight-view")!.hidden = page !== "flights";
    document.getElementById("canvas")!.hidden = page !== "flights";
    document.getElementById("implementation-pages")!.hidden = page === "flights";
    for (const link of links) {
      if (link.dataset.guidePage === page) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    for (const key of pages.keys()) {
      if (key !== "flights") document.getElementById(`menu-${key}`)!.hidden = key !== page;
    }
    document.title = `Million Drones — ${pages.get(page)}`;
    if (page !== current) {
      onNavigate();
      document.getElementById("implementation-pages")!.scrollTop = 0;
      if (current && page !== "flights")
        document.querySelector<HTMLElement>(`#menu-${page} h1`)?.focus({ preventScroll: true });
      current = page;
    }
  }
  for (const link of links) link.addEventListener("click", event => {
    if (!canNavigate()) event.preventDefault();
  });
  window.addEventListener("hashchange", refresh);
  refresh();
  return { refresh };
}
