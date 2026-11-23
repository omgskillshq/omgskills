// Fills in a skill page's review badge for the exact version it shows. Without an answer the badge
// stays "Not reviewed yet"; it only shows what the review found.
(function () {
  try {
    var badges = document.querySelectorAll("[data-skill-review][data-tree]");
    if (!badges.length || !window.fetch) return;
    var words = {
      no_issues: ["No issues found", "Our rules and an AI review found no issues in this version"],
      under_review: ["Under review", "Our checks flagged something in this version and the second look didn't clear it. Read it closely before you install it."],
      not_reviewed: ["Not reviewed yet", "We haven't reviewed this version yet."]
    };
    Array.prototype.forEach.call(badges, function (badge) {
      var url = "/api/skill-review?id=" + encodeURIComponent(badge.getAttribute("data-skill-review")) +
        "&tree=" + encodeURIComponent(badge.getAttribute("data-tree"));
      fetch(url, { credentials: "omit" }).then(function (response) {
        return response.ok ? response.json() : null;
      }).then(function (result) {
        var text = result && words[result.badge];
        if (!text) return;
        var title = text[1];
        if (result.badge === "no_issues") {
          var day = result.reviewedAt ? new Date(result.reviewedAt) : null;
          title += (day && !isNaN(day) ? " (checked " + day.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + ")" : "") +
            ". It's a check, not a guarantee.";
        }
        badge.textContent = text[0];
        badge.setAttribute("title", title);
        badge.setAttribute("data-state", result.badge);
      }).catch(function () {});
    });
  } catch (error) {}
})();
