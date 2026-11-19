const publisherId = document.querySelector('meta[name="google-adsense-account"]')?.content.trim() || "";
const placements = [...document.querySelectorAll("[data-adsense-slot]")].filter((placement) =>
  /^\d+$/.test(placement.dataset.adsenseSlot || "")
);

if (/^ca-pub-\d+$/.test(publisherId) && placements.length) {
  placements.forEach((placement) => {
    const ad = document.createElement("ins");
    ad.className = "adsbygoogle";
    ad.style.display = "block";
    ad.dataset.adClient = publisherId;
    ad.dataset.adSlot = placement.dataset.adsenseSlot;
    ad.dataset.adFormat = "auto";
    ad.dataset.fullWidthResponsive = "true";
    placement.replaceChildren(ad);
    placement.hidden = false;
  });

  const script = document.createElement("script");
  script.async = true;
  script.crossOrigin = "anonymous";
  script.src = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${encodeURIComponent(publisherId)}`;
  script.onload = () => {
    const queue = window.adsbygoogle = window.adsbygoogle || [];
    placements.forEach(() => queue.push({}));
  };
  script.onerror = () => {
    placements.forEach((placement) => { placement.hidden = true; });
    console.error("Google AdSense failed to load.");
  };
  document.head.append(script);
}
