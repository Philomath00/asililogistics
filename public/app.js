const $ = (s) => document.querySelector(s),
  esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const params = new URLSearchParams(location.search),
  mode = params.has("rider")
    ? "rider"
    : params.has("track")
      ? "track"
      : "admin",
  access = params.get(mode);
let rows = [],
  selected = null,
  map,
  layers,
  watchId = null,
  key = sessionStorage.getItem("asili-key") || "",
  lastFit = "",
  lastGps = 0;
const names = {
    assigned: "Assigned",
    at_pickup: "At pickup",
    picked_up: "Collected",
    in_transit: "In transit",
    delivered: "Delivered",
    cancelled: "Cancelled",
  },
  next = {
    assigned: "at_pickup",
    at_pickup: "picked_up",
    picked_up: "in_transit",
    in_transit: "delivered",
  };
async function api(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: "Bearer " + key } : {}),
      ...options.headers,
    },
  });
  if (!res.ok) {
    let e;
    try {
      e = await res.json();
    } catch {
      e = {
        error:
          res.status === 404
            ? "Delivery link not found"
            : "Request failed (" + res.status + ")",
      };
    }
    throw Error(e.error);
  }
  return res.json();
}
let demoNotice = "";
function notice(s) {
  $("#notice").textContent = [demoNotice, s].filter(Boolean).join(" · ");
}
function initMap() {
  if (!window.L) {
    notice(
      "Map library could not load. Delivery controls are still available.",
    );
    return;
  }
  map = L.map("map").setView([-1.9441, 30.0619], 12);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    referrerPolicy: "strict-origin",
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  })
    .addTo(map)
    .on("tileerror", () =>
      notice(
        "Map tiles unavailable. Coordinates and delivery controls remain available.",
      ),
    );
  layers = L.layerGroup().addTo(map);
}
function renderMap(d) {
  if (!map) return;
  layers.clearLayers();
  const points = [];
  for (const [p, label, color] of [
    [d.pickup, "Pickup", "#517e40"],
    [d.dropoff, "Destination", "#263c31"],
    [d.location, "Rider", "#d3932c"],
  ]) {
    if (!p) continue;
    points.push([p.lat, p.lng]);
    L.circleMarker([p.lat, p.lng], {
      radius: 9,
      color: "white",
      weight: 3,
      fillColor: color,
      fillOpacity: 1,
    })
      .bindTooltip(label)
      .addTo(layers);
  }
  L.polyline(
    [
      [d.pickup.lat, d.pickup.lng],
      [d.dropoff.lat, d.dropoff.lng],
    ],
    { color: "#779963", dashArray: "6 8", weight: 3 },
  ).addTo(layers);
  if (lastFit !== d.id) {
    map.fitBounds(points, { padding: [35, 35], maxZoom: 15 });
    lastFit = d.id;
  }
}
function renderDetails(d) {
  selected = d.id;
  renderMap(d);
  const closed = ["delivered", "cancelled"].includes(d.status);
  $("#details").innerHTML =
    `<div class="delivery-top"><h2>${esc(d.id)}</h2><span class="status ${esc(d.status)}">${esc(names[d.status])}</span></div><div class="route"><div><small class="muted">● PICKUP</small><strong>${esc(d.pickup.label)}</strong><small>${d.pickup.lat.toFixed(5)}, ${d.pickup.lng.toFixed(5)}</small></div><div><small class="muted">◉ DESTINATION</small><strong>${esc(d.dropoff.label)}</strong><small>${d.dropoff.lat.toFixed(5)}, ${d.dropoff.lng.toFixed(5)}</small></div></div><p>Rider: ${esc(d.riderName)} · ${d.location ? "Last GPS update " + esc(new Date(d.location.at).toLocaleString()) : "Waiting for rider GPS"}</p><p class="muted">Dashed line connects stops; it is not a road route or ETA.</p>${mode === "admin" ? `<p>${esc(d.description)}</p><div class="actions"><a href="/?rider=${d.riderToken}" target="_blank" rel="noopener">Open rider workspace ↗</a><a href="/?track=${d.trackingToken}" target="_blank" rel="noopener">Customer tracking ↗</a><button id="copy-rider" class="secondary">Copy rider link</button><button id="copy-track" class="secondary">Copy customer link</button>${!closed ? '<button id="cancel" class="secondary">Cancel delivery</button>' : ""}</div>` : ""}${mode === "rider" ? `<p>${esc(d.description)}</p><p>Sender: ${esc(d.senderName)} · <a href="tel:${esc(d.senderPhone)}">${esc(d.senderPhone)}</a><br>Customer: ${esc(d.customerName)} · <a href="tel:${esc(d.customerPhone)}">${esc(d.customerPhone)}</a></p>${!closed ? `<div class="actions"><button id="gps">${watchId === null ? "Share live GPS" : "Stop sharing GPS"}</button><button id="advance">${esc(names[next[d.status]])} →</button><a target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/dir/?api=1&destination=${d.status === "assigned" || d.status === "at_pickup" ? d.pickup.lat + "," + d.pickup.lng : d.dropoff.lat + "," + d.dropoff.lng}&travelmode=driving">Open navigation ↗</a></div><p>Share GPS only while on this delivery. Keep this page open; background updates may pause.</p>` : ""}` : ""}<ol>${d.history.map((h) => `<li>${esc(names[h.status])} <small class="muted">${esc(new Date(h.at).toLocaleString())}</small></li>`).join("")}</ol>${d.proof ? `<div class="proof">Delivery confirmed by rider · Received by ${esc(d.proof.receivedBy)}</div>` : ""}`;
  if (closed && watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  if ($("#copy-rider"))
    $("#copy-rider").onclick = () =>
      copy(location.origin + "/?rider=" + d.riderToken);
  if ($("#copy-track"))
    $("#copy-track").onclick = () =>
      copy(location.origin + "/?track=" + d.trackingToken);
  if ($("#cancel"))
    $("#cancel").onclick = async () => {
      if (confirm("Cancel this delivery?"))
        try {
          await api("/api/deliveries/" + d.id + "/cancel", { method: "POST" });
          await refresh();
        } catch (e) {
          notice(e.message);
        }
    };
  if ($("#gps"))
    $("#gps").onclick = () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        renderDetails(d);
        return;
      }
      if (!navigator.geolocation) {
        notice("GPS is unavailable in this browser.");
        return;
      }
      watchId = navigator.geolocation.watchPosition(
        async (p) => {
          if (Date.now() - lastGps < 5000) return;
          lastGps = Date.now();
          try {
            await api("/api/rider/" + access + "/location", {
              method: "POST",
              body: JSON.stringify({
                lat: p.coords.latitude,
                lng: p.coords.longitude,
              }),
            });
            await refresh();
          } catch (e) {
            notice(e.message);
          }
        },
        (e) => notice("GPS: " + e.message),
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
      renderDetails(d);
    };
  if ($("#advance"))
    $("#advance").onclick = async () => {
      let receivedBy;
      if (next[d.status] === "delivered") {
        receivedBy = prompt("Who received the parcel?");
        if (!receivedBy?.trim()) return;
      }
      try {
        await api("/api/rider/" + access + "/status", {
          method: "POST",
          body: JSON.stringify({ status: next[d.status], receivedBy }),
        });
        await refresh();
      } catch (e) {
        notice(e.message);
      }
    };
}
async function copy(s) {
  try {
    await navigator.clipboard.writeText(s);
    notice("Link copied. Share it privately with the intended recipient.");
  } catch {
    notice("Copy from the address bar after opening the link.");
  }
}
function renderList() {
  const q = $("#search").value.toLowerCase(),
    shown = rows.filter((d) =>
      [d.id, d.customerName, d.riderName, d.status]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  $("#list").innerHTML = shown.length
    ? shown
        .map(
          (d) =>
            `<article class="delivery ${selected === d.id ? "active" : ""}" tabindex="0" role="button" data-id="${d.id}"><div class="delivery-top"><strong>${esc(d.id)}</strong><span class="status ${d.status}">${esc(names[d.status])}</span></div><p>${esc(d.pickup.label)} → ${esc(d.dropoff.label)}</p><small>${esc(d.riderName)} ${mode === "admin" ? "· " + esc(d.customerName) : ""}</small></article>`,
        )
        .join("")
    : '<div class="empty">No deliveries yet.<br>Create your first delivery to get moving.</div>';
  document.querySelectorAll("[data-id]").forEach((el) => {
    const choose = () => {
      selected = el.dataset.id;
      renderList();
      renderDetails(rows.find((d) => d.id === selected));
    };
    el.onclick = choose;
    el.onkeydown = (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    };
  });
}
async function refresh() {
  try {
    if (mode === "admin") {
      rows = await api("/api/deliveries");
      const messages = await api("/api/messages");
      $("#messages").innerHTML = messages.length
        ? messages
            .map(
              (m) =>
                `<div class="message"><div><strong>${esc(m.recipient)} <span class="pill">${esc(m.state)}</span></strong><p>${esc(m.body)}</p></div>${m.state === "pending" ? `<button data-send="${m.id}" class="secondary">Send</button>` : ""}</div>`,
            )
            .join("")
        : "<p>No updates queued yet.</p>";
      document.querySelectorAll("[data-send]").forEach(
        (b) =>
          (b.onclick = async () => {
            b.disabled = true;
            try {
              await api("/api/messages/" + b.dataset.send + "/send", {
                method: "POST",
              });
              await refresh();
            } catch (e) {
              notice(e.message);
              b.disabled = false;
            }
          }),
      );
    } else rows = [await api("/api/" + mode + "/" + access)];
    $("#stats").innerHTML = [
      ["Total deliveries", rows.length],
      [
        "On the move",
        rows.filter((d) => ["picked_up", "in_transit"].includes(d.status))
          .length,
      ],
      ["Delivered", rows.filter((d) => d.status === "delivered").length],
      [
        "Awaiting pickup",
        rows.filter((d) => ["assigned", "at_pickup"].includes(d.status)).length,
      ],
    ]
      .map(
        ([name, n]) =>
          `<div class="stat"><span>${name}</span><b>${n.toString().padStart(2, "0")}</b><span>Delivery overview</span></div>`,
      )
      .join("");
    renderList();
    const d = rows.find((d) => d.id === selected) || rows[0];
    if (d) renderDetails(d);
  } catch (e) {
    notice(e.message);
  }
}
$("#search").oninput = renderList;
$("#login").onclick = () => {
  const k = prompt("Dispatcher key (stored only in this tab)");
  if (k === null) return;
  key = k;
  sessionStorage.setItem("asili-key", k);
  refresh();
};
$("#new").onclick = () => $("#dialog").showModal();
$("#close").onclick = () => $("#dialog").close();
$("#create").onsubmit = async (e) => {
  e.preventDefault();
  const form = e.target,
    b = Object.fromEntries(new FormData(form)),
    button = form.querySelector('button:not([type="button"])');
  for (const prefix of ["pickup", "dropoff"]) {
    b[prefix] = {
      label: b[prefix + "Label"],
      lat: Number(b[prefix + "Lat"]),
      lng: Number(b[prefix + "Lng"]),
    };
  }
  button.disabled = true;
  try {
    const d = await api("/api/deliveries", {
      method: "POST",
      body: JSON.stringify(b),
    });
    selected = d.id;
    form.reset();
    $("#dialog").close();
    await refresh();
  } catch (e) {
    $("#form-error").textContent = e.message;
  } finally {
    button.disabled = false;
  }
};
if (mode !== "admin") {
  $("#new").hidden = true;
  $("#login").hidden = true;
  $("#outbox").hidden = true;
  $("#heading").textContent =
    mode === "rider" ? "Your next delivery." : "Your delivery, in view.";
  $("#subtitle").textContent =
    mode === "rider"
      ? "Update progress and share your location throughout the journey."
      : "Follow pickup, movement and delivery in one place.";
  $("#list-title").textContent = "Delivery journey";
}
initMap();
api("/api/health")
  .then((h) => {
    if (mode === "admin" && h.demo) {
      demoNotice =
        "Local demo mode · No dispatcher key set. Use sample details only. Set ADMIN_KEY before sharing this server.";
      notice("");
    }
  })
  .catch((e) => notice(e.message));
refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 5000);
