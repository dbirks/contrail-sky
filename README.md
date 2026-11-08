# Contrail Sky

**Is that a rocket? Or a plane way up high?**

A little interactive toy for curious kids (and grown-ups who look up and wonder). Sometimes a
contrail sits low near the horizon, thin and pointy, and it *looks* exactly like a rocket climbing
away from us. Contrail Sky shows what is really going on: the plane is cruising about **11 km
(around 7 miles) above the ground**, way off in the distance. It only looks low because the Earth is
round and big — distance, not a rocket.

Two views, one idea. Drag to look around, pinch or scroll to zoom.

## 🧍 On the ground

You are standing in your home town (Indianapolis by default) at dusk, looking at the sky. Planes
cross overhead and leave contrails; a plane that has just come over the horizon is *near the
horizon* while it is already high above ground.

The gauge at the bottom tells the story in numbers you can check yourself: how many degrees above
the horizon the plane appears, how high it is in miles/km, and how far away along the ground it
really is. "It looks low, almost like a rocket taking off. But it's really 7 miles up. It only looks
low because it's so far away!" The **How high am I?** slider lifts you from the ground past plane
height, to the edge of space and the space station, so you can see the same scene from above.

## 🌍 Globe

Zoom all the way out and the same planes and contrails sit on a round Earth with real cities on it.
From out here the situation is obvious: the plane is a tiny dot 11 km above the surface, the contrail
is a thread along its path, and your "horizon" is just the flat eye-level line of the little patch of
world you can see. Turn on **Stretch heights ×5** if you want the altitudes exaggerated enough to
spot them from orbit, and **See what you'd see from here** to jump back down to the ground at that
spot.

## ⬆️ The "move 150 miles east" lesson

Press **150 miles east** (or drag the "Where are you standing?" slider) and you travel ~240 km down
the road, to a place near Dayton, Ohio. The plane that was a low, faint streak near *your* horizon is
now almost straight overhead, high in the sky and easy to see. Nothing about the plane changed — only
where you were standing. That is the whole trick: a contrail that looks like a rocket launching is a
normal airliner about 11 km up, a couple of hundred kilometres away, and if you stand somewhere closer
to it, it is simply up, up, up.

Back on the **Home** side, **Find the plane** aims your view at the best example so you can compare.

## Live site

**https://dbirks.github.io/contrail-sky/** — built and published by
[`.github/workflows/pages.yaml`](.github/workflows/pages.yaml) on every push to `main`
(the Pages build sets `BASE_PATH=/contrail-sky/`; other builds use relative paths).

## Running it

Requires [node 24](https://nodejs.org) and [pnpm](https://pnpm.io) 10 (`corepack enable`).

```bash
pnpm install     # install dependencies
pnpm dev         # dev server with hot reload
pnpm build       # type-check + production build into dist/
```

## Container

`Dockerfile` builds the site and serves it with unprivileged nginx (uid 101, port 8080).

```bash
docker build -t contrail-sky .
docker run -d --rm -p 8080:8080 --name contrail-sky contrail-sky
# then open http://localhost:8080  (health check: http://localhost:8080/healthz)
```

Images for `main` are built by [`.github/workflows/build.yaml`](.github/workflows/build.yaml)
and pushed to `ghcr.io/dbirks/contrail-sky`.

## Credits

Earth imagery: NASA Earth Observatory Blue Marble Next Generation (public domain, attribution requested).
