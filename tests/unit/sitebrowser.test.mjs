import { test } from "node:test";
import assert from "node:assert/strict";
import { ROOT, sites } from "../helpers/terrain.mjs";
const { searchSites, inArc, cardinal, FavouriteStore } = await import(`${ROOT}/public/js/sitebrowser.js`);

const names = (list) => list.map((s) => s.name);

test("inArc handles arcs that wrap through north", () => {
  assert.ok(inArc(350, [315, 22.5]) && inArc(10, [315, 22.5]) && !inArc(90, [315, 22.5]));
  assert.ok(inArc(200, [180, 225]) && !inArc(170, [180, 225]));
  assert.ok(inArc(-10, [315, 22.5]), "negative degrees normalised");
});

test("cardinal names", () => {
  assert.equal(cardinal(0), "N"); assert.equal(cardinal(326), "NW"); assert.equal(cardinal(146), "SE"); assert.equal(cardinal(359), "N");
});

test("empty query lists every site, A–Z", () => {
  const r = searchSites(sites, "");
  assert.equal(r.length, sites.length);
  assert.deepEqual(names(r), [...names(r)].sort((a, b) => a.localeCompare(b)));
});

test("search by name, region, club; case and accent insensitive; all terms must match", () => {
  assert.deepEqual(names(searchSites(sites, "beachy")), ["Beachy Head"]);
  assert.deepEqual(names(searchSites(sites, "DYKE")), ["Devil's Dyke"]);
  assert.deepEqual(names(searchSites(sites, "west sussex")), ["Devil's Dyke"]);
  assert.equal(searchSites(sites, "shgc").length, sites.filter((s) => s.clubShort === "SHGC").length);
  assert.equal(searchSites(sites, "east sussex").length, sites.filter((s) => /east sussex/i.test(s.region)).length);
  assert.deepEqual(searchSites([{ ...sites[0], name: "Côte d'Azur" }], "cote").length, 1);
  assert.equal(searchSites(sites, "beachy dyke").length, 0);
});

test("a compass direction finds the sites that work in that wind", () => {
  const nw = names(searchSites(sites, "NW"));
  assert.ok(nw.includes("Devil's Dyke") && nw.includes("Firle"), nw.join());
  assert.ok(!nw.includes("Beachy Head"));
  assert.deepEqual(names(searchSites(sites, "s")).sort(), names(sites.filter((s) => inArc(180, s.windFrom))).sort());
});

test("favourites filter and favourites first", () => {
  const fav = new Set(["newhaven-cliffs"]);
  assert.equal(searchSites(sites, "", { favourites: fav })[0].slug, "newhaven-cliffs");
  assert.deepEqual(searchSites(sites, "", { favourites: fav, onlyFavourites: true }).map((s) => s.slug), ["newhaven-cliffs"]);
});

test("favourites persist through storage and survive broken storage", () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const a = new FavouriteStore(storage);
  assert.equal(a.toggle("firle"), true);
  assert.equal(new FavouriteStore(storage).has("firle"), true, "persisted");
  assert.equal(a.toggle("firle"), false);
  assert.equal(new FavouriteStore(storage).has("firle"), false);
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  const b = new FavouriteStore(broken);
  assert.equal(b.toggle("firle"), true, "works in memory when storage throws");
  const corrupt = new FavouriteStore({ getItem: () => "{not json", setItem: () => {} });
  assert.equal(corrupt.has("firle"), false);
});

test("favourites saved under the pre-rename key are kept", () => {
  const mem = new Map([["ridgelift:favourites", JSON.stringify(["firle"])]]);
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  const f = new FavouriteStore(storage);
  assert.equal(f.has("firle"), true);
  f.toggle("bo-peep");
  assert.deepEqual(JSON.parse(mem.get("lifty:favourites")).sort(), ["bo-peep", "firle"]);
});
