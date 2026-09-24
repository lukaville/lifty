// Site browser: a searchable list and a map of all flying sites, with
// favourites. Each row (and map marker) shows whether the site works in the
// current wind.
//
//   const browser = new SiteBrowser({ sites, onSelect, getWindDir });
//   browser.setCurrent(slug); browser.refresh(); browser.open(); browser.close();
//
// Search matches name, region, club and country, or a compass direction:
// "NW" lists the sites whose working arc includes north-west.
// Favourites live in localStorage (a per-viewer convenience; failures ignored).
// The map (Leaflet + OpenStreetMap) is loaded lazily the first time it's shown.

const FAV_KEY = "lifty:favourites";
const OLD_FAV_KEY = "ridgelift:favourites";   // before the project was renamed
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
export const cardinal = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];

export function inArc(deg, [a, b]) {
  deg = ((deg % 360) + 360) % 360;
  return a <= b ? deg >= a && deg <= b : deg >= a || deg <= b;
}

const norm = (s) => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Filter + rank sites for a query. Pure, so it's unit-tested directly.
export function searchSites(sites, query, { favourites = new Set(), onlyFavourites = false } = {}) {
  const q = norm(query).trim();
  const compass = COMPASS.indexOf(q.toUpperCase());
  let out = sites.filter((s) => {
    if (onlyFavourites && !favourites.has(s.slug)) return false;
    if (!q) return true;
    if (compass >= 0) return inArc(compass * 22.5, s.windFrom);
    const hay = norm([s.name, s.region, s.club, s.clubShort, s.country, s.slug].join(" "));
    return q.split(/\s+/).every((t) => hay.includes(t));
  });
  // favourites first, then name matches that start with the query, then A–Z
  const rank = (s) => (favourites.has(s.slug) ? 0 : 2) + (q && norm(s.name).startsWith(q) ? 0 : 1);
  out = out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return out;
}

export class FavouriteStore {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.set = new Set();
    try { this.set = new Set(JSON.parse(storage?.getItem(FAV_KEY) || storage?.getItem(OLD_FAV_KEY) || "[]")); } catch { /* private mode etc. */ }
  }
  has(slug) { return this.set.has(slug); }
  toggle(slug) {
    if (this.set.has(slug)) this.set.delete(slug); else this.set.add(slug);
    try { this.storage?.setItem(FAV_KEY, JSON.stringify([...this.set])); } catch { /* ignore */ }
    return this.set.has(slug);
  }
}

// small wind-rose icon: the working arc in green, the current wind as a needle
function roseSVG(arc, windDir, works) {
  const r = 11, c = 13, pt = (d, rr) => [c + rr * Math.sin((d * Math.PI) / 180), c - rr * Math.cos((d * Math.PI) / 180)];
  const span = (arc[1] - arc[0] + 360) % 360 || 360;
  const [x1, y1] = pt(arc[0], r), [x2, y2] = pt(arc[0] + span, r);
  const big = span > 180 ? 1 : 0;
  const [wx, wy] = pt(windDir, r - 1), [tx, ty] = pt(windDir, 3);
  return `<svg class="rose" viewBox="0 0 26 26" aria-hidden="true">
    <circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="1.5"/>
    <path d="M ${x1} ${y1} A ${r} ${r} 0 ${big} 1 ${x2} ${y2}" fill="none" stroke="${works ? "#46e08a" : "#6f8a78"}" stroke-width="3" stroke-linecap="round"/>
    <line x1="${wx}" y1="${wy}" x2="${tx}" y2="${ty}" stroke="#9fe0ff" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;
}

export class SiteBrowser {
  constructor({ sites, onSelect, getWindDir, root = document }) {
    this.sites = sites;
    this.onSelect = onSelect;
    this.getWindDir = getWindDir;
    this.fav = new FavouriteStore();
    this.current = null;
    this.filter = "all";            // all | fav
    this.view = "list";             // list | map
    this.$ = (sel) => root.querySelector(sel);
    this.panel = this.$("#sitesPanel");
    this.search = this.$("#siteSearch");
    this.list = this.$("#siteResults");
    this.mapEl = this.$("#siteMap");
    this.count = this.$("#sitesCount");
    this.active = -1;               // keyboard highlight in the list

    this.$("#siteButton").addEventListener("click", () => (this.isOpen() ? this.close() : this.open()));
    this.$("#sitesClose").addEventListener("click", () => this.close());
    this.search.addEventListener("input", () => { this.active = -1; this.render(); });
    this.search.addEventListener("keydown", (e) => this._keys(e));
    for (const b of this.panel.querySelectorAll("[data-filter]")) {
      b.addEventListener("click", () => { this.filter = b.dataset.filter; this.render(); });
    }
    for (const b of this.panel.querySelectorAll("[data-view]")) {
      b.addEventListener("click", () => this.setView(b.dataset.view));
    }
    this.list.addEventListener("click", (e) => {
      const star = e.target.closest(".star");
      const row = e.target.closest(".site-row");
      if (!row) return;
      if (star) { e.stopPropagation(); this.toggleFavourite(row.dataset.slug); return; }
      this.select(row.dataset.slug);
    });
    const favBtn = this.$("#favStar");
    favBtn?.addEventListener("click", (e) => { e.stopPropagation(); if (this.current) this.toggleFavourite(this.current); });
    addEventListener("keydown", (e) => {
      if (e.key === "/" && !/input|select|textarea/i.test(document.activeElement?.tagName)) { e.preventDefault(); this.open(); }
      else if (e.key === "Escape" && this.isOpen()) this.close();
    });
  }

  isOpen() { return !this.panel.hidden; }
  open() {
    this.panel.hidden = false;
    this.$("#siteButton").setAttribute("aria-expanded", "true");
    this.render();
    if (this.view === "map") this._ensureMap();
    // don't pop the on-screen keyboard over the list on touch screens
    if (!matchMedia("(pointer: coarse)").matches) this.search.focus();
    this.panel.dispatchEvent(new CustomEvent("sites:open", { bubbles: true }));
  }
  close() {
    this.panel.hidden = true;
    this.$("#siteButton").setAttribute("aria-expanded", "false");
  }
  setView(v) {
    this.view = v;
    for (const b of this.panel.querySelectorAll("[data-view]")) b.setAttribute("aria-pressed", String(b.dataset.view === v));
    this.list.hidden = v !== "list";
    this.mapEl.hidden = v !== "map";
    if (v === "map") this._ensureMap();
  }

  setCurrent(slug) {
    this.current = slug;
    const s = this.sites.find((x) => x.slug === slug);
    this.$("#siteButtonName").textContent = s?.name ?? "—";
    this.$("#siteButtonRegion").textContent = s ? [s.region, s.clubShort].filter(Boolean).join(" · ") : "";
    this._syncStar();
    this.render();
  }
  toggleFavourite(slug) {
    this.fav.toggle(slug);
    this._syncStar();
    this.render();
  }
  select(slug) {
    this.close();
    if (slug !== this.current) this.onSelect(slug);
  }

  results() {
    return searchSites(this.sites, this.search.value, { favourites: this.fav.set, onlyFavourites: this.filter === "fav" });
  }

  // re-render (cheap; called on wind changes while open)
  refresh() { if (this.isOpen()) this.render(); }

  render() {
    const dir = this.getWindDir();
    for (const b of this.panel.querySelectorAll("[data-filter]")) b.setAttribute("aria-pressed", String(b.dataset.filter === this.filter));
    const res = this.results();
    this.count.textContent = `${res.length} of ${this.sites.length}`;
    if (this.active >= res.length) this.active = res.length - 1;
    this.list.innerHTML = res.length ? res.map((s, i) => {
      const works = inArc(dir, s.windFrom), fav = this.fav.has(s.slug);
      return `<li class="site-row${s.slug === this.current ? " current" : ""}${i === this.active ? " kb" : ""}" data-slug="${esc(s.slug)}" role="option" aria-selected="${s.slug === this.current}">
        ${roseSVG(s.windFrom, dir, works)}
        <div class="meta"><div class="nm">${esc(s.name)}</div><div class="rg">${esc([s.region, s.clubShort].filter(Boolean).join(" · "))}</div></div>
        <div class="ww"><span class="${works ? "on" : "off"}">${works ? "works now" : "off wind"}</span><br>${esc(s.workingWind)}</div>
        <button class="star" type="button" aria-label="${fav ? "Remove from" : "Add to"} favourites" aria-pressed="${fav}">${fav ? "★" : "☆"}</button>
      </li>`;
    }).join("") : `<li class="empty">No sites match${this.filter === "fav" ? " — star a site to add it to favourites" : ""}.</li>`;
    if (this.map) this._renderMarkers(res, dir);
  }

  _syncStar() {
    const b = this.$("#favStar");
    if (!b || !this.current) return;
    const on = this.fav.has(this.current);
    b.textContent = on ? "★" : "☆";
    b.setAttribute("aria-pressed", String(on));
    b.setAttribute("aria-label", on ? "Remove from favourites" : "Add to favourites");
  }

  _keys(e) {
    const res = this.results();
    if (e.key === "ArrowDown") { this.active = Math.min(res.length - 1, this.active + 1); this.render(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { this.active = Math.max(0, this.active - 1); this.render(); e.preventDefault(); }
    else if (e.key === "Enter" && res.length) { this.select(res[Math.max(0, this.active)].slug); }
  }

  // ------------------------------------------------------------------ map
  async _ensureMap() {
    if (this.map || this._loadingMap) { this.map?.invalidateSize(); return; }
    this._loadingMap = true;
    try {
      if (!globalThis.L) {
        const css = document.createElement("link");
        css.rel = "stylesheet"; css.href = "./vendor/leaflet/leaflet.css";
        document.head.appendChild(css);
        await new Promise((res, rej) => {
          const sc = document.createElement("script");
          sc.src = "./vendor/leaflet/leaflet.js"; sc.onload = res; sc.onerror = rej;
          document.head.appendChild(sc);
        });
      }
      const L = globalThis.L;
      this.map = L.map(this.mapEl, { zoomControl: true, attributionControl: true });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 17, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
      }).addTo(this.map);
      this.markers = L.layerGroup().addTo(this.map);
      this.render();
      const res = this.results();
      this._fit(res.length ? res : this.sites);
    } catch (e) {
      console.warn("map unavailable", e);
      this.mapEl.textContent = "Map unavailable offline.";
    } finally {
      this._loadingMap = false;
    }
  }
  _fit(sites) {
    const L = globalThis.L;
    if (!this.map || !sites.length) return;
    const b = L.latLngBounds(sites.map((s) => [s.lat, s.lon]));
    this.map.fitBounds(b.pad(0.3), { maxZoom: 12 });
  }
  _renderMarkers(res, dir) {
    const L = globalThis.L;
    this.markers.clearLayers();
    for (const s of res) {
      const works = inArc(dir, s.windFrom), cur = s.slug === this.current;
      const m = L.circleMarker([s.lat, s.lon], {
        radius: cur ? 9 : 7, weight: cur ? 3 : 1.5, color: cur ? "#56b6ff" : "#1b2530",
        fillColor: works ? "#46e08a" : "#8a96a3", fillOpacity: 0.95,
      });
      m.bindTooltip(`${esc(s.name)} · ${esc(s.workingWind)}`, { direction: "top" });
      m.on("click", () => this.select(s.slug));
      m.addTo(this.markers);
    }
  }
}
