async function loadPartial(selector, target) {
  const host = typeof selector === "string" ? document.querySelector(selector) : selector;
  if (!host) return;
  try {
    const response = await fetch(target);
    if (response.ok) host.innerHTML = await response.text();
  } catch (_) {}
}

document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll("[data-include]").forEach((el) => loadPartial(el, el.getAttribute("data-include")));
  loadPartial("#site-header", "partials/header.html");
  loadPartial("#site-footer", "partials/footer.html");
});
