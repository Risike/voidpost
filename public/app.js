// Tiny progressive enhancements: live inbox refresh and address copying.

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;
  const value = button.getAttribute("data-copy");
  try {
    await navigator.clipboard.writeText(value);
    const original = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = original;
    }, 1500);
  } catch {
    button.textContent = "Copy failed";
  }
});

const box = document.body.dataset.box;
if (box) {
  let known = document.body.dataset.count;
  setInterval(async () => {
    try {
      const response = await fetch(`/api/mailbox/${encodeURIComponent(box)}`, {
        headers: { accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) return;
      const data = await response.json();
      if (String(data.count) !== known) window.location.reload();
    } catch {
      // Offline or server restarting: try again on the next tick.
    }
  }, 5000);
}
