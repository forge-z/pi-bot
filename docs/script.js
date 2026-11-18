// Progressive enhancement only. The page works without this file.
(function () {
  "use strict";

  function markMissing(img) {
    var shot = img.closest(".shot");
    if (shot) shot.classList.add("is-missing");
  }

  document.querySelectorAll(".shot img").forEach(function (img) {
    if (img.complete && img.naturalWidth === 0) markMissing(img);
    img.addEventListener("error", function () {
      markMissing(img);
    });
    img.addEventListener("load", function () {
      var shot = img.closest(".shot");
      if (shot) shot.classList.remove("is-missing");
    });
  });

  if (!navigator.clipboard || !window.isSecureContext) return;

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    var source = document.getElementById(button.getAttribute("data-copy"));
    if (!source) return;
    var label = button.textContent;
    var done = button.getAttribute("data-done") || "Copied";
    button.hidden = false;

    button.addEventListener("click", function () {
      var clone = source.cloneNode(true);
      clone.querySelectorAll(".p").forEach(function (el) {
        el.remove();
      });
      var text = clone.textContent.replace(/\n{3,}/g, "\n\n").trim() + "\n";
      navigator.clipboard.writeText(text).then(
        function () {
          button.textContent = done;
          setTimeout(function () {
            button.textContent = label;
          }, 1800);
        },
        function () {
          /* Clipboard refused: leave the button as it was. */
        },
      );
    });
  });
})();
