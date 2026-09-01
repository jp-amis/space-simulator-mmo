// In-app player guide (the old PLAYER_GUIDE.md, now served to everyone in the client).
// A scrollable overlay opened from the ID screen and the top bar.
//
// IMPORTANT: this is the single source of truth for how the game plays — keep it in sync
// whenever gameplay changes (controls, modules, orders, mining/logistics, etc.).
// Tutorial screenshots live in `apps/client/public/guide/*.png`.

const CSS = `
#guide-overlay { position:absolute; inset:0; z-index:40; display:none; background:rgba(4,7,12,0.92); overflow:auto; }
#guide-overlay .guide-inner { max-width:820px; margin:0 auto; padding:32px 24px 64px; color:#cdd6e4; font-family:system-ui,sans-serif; line-height:1.55; }
#guide-overlay h1 { font-size:26px; margin:0 0 6px; color:#eaf2ff; }
#guide-overlay h2 { font-size:20px; margin:28px 0 8px; color:#8ed0ff; border-bottom:1px solid #1b2433; padding-bottom:4px; }
#guide-overlay h3 { font-size:16px; margin:18px 0 6px; color:#cfe6ff; }
#guide-overlay h4 { font-size:14px; margin:14px 0 4px; color:#9fb2c8; text-transform:uppercase; letter-spacing:.04em; }
#guide-overlay p, #guide-overlay li { font-size:14px; }
#guide-overlay ul, #guide-overlay ol { margin:6px 0 6px 20px; padding:0; }
#guide-overlay code { background:#0d1420; border:1px solid #1b2433; border-radius:4px; padding:1px 4px; font-size:12px; }
#guide-overlay blockquote { margin:10px 0; padding:8px 12px; border-left:3px solid #54c8ff; background:rgba(84,200,255,0.06); color:#bcd; }
#guide-overlay table { width:100%; border-collapse:collapse; margin:8px 0; font-size:13px; }
#guide-overlay th, #guide-overlay td { border:1px solid #23304a; padding:5px 8px; text-align:left; }
#guide-overlay th { background:#111a28; color:#9fb2c8; }
#guide-overlay figure { margin:14px 0; }
#guide-overlay img { width:100%; border:1px solid #23304a; border-radius:8px; display:block; background:#05070c; }
#guide-overlay figcaption { font-size:12px; color:#7c8ba3; margin-top:4px; text-align:center; }
#guide-overlay .guide-note { color:#7c8ba3; font-size:13px; }
#guide-close { position:sticky; top:0; float:right; margin:-8px -8px 0 0; border:none; background:#1b2433; color:#cdd6e4; width:34px; height:34px; border-radius:8px; font-size:18px; cursor:pointer; z-index:2; }
`;

const shot = (src: string, caption: string) =>
  `<figure><img src="/guide/${src}" alt="${caption}" loading="lazy" /><figcaption>${caption}</figcaption></figure>`;

const BODY = `
<h1>Player Guide — Space Strategy MMO</h1>
<p>A web-based space strategy game. You command a home planet and fleets of <strong>modular ships</strong>,
move them freely through 2D space, <strong>mine and haul resources</strong> to fund your war machine, and fight
<strong>continuous, FTL-style battles right on the map</strong> — where your ship designs and doctrine, not a single
power number, decide the outcome.</p>
<blockquote>Prototype build: no accounts, no saving. Your player ID <em>is</em> your world key, and everything resets
when the server restarts. Visuals are drawn procedurally.</blockquote>
${shot("map.png", "The strategic map — planets, your fleet, and the procedural starfield.")}

<h2>Getting started</h2>
<ol>
<li>Type <strong>any</strong> name into the ID box and click <strong>Connect</strong>. That name is your identity —
reconnect with the same name (while the server is running) to return to your world. A name that's <em>already online</em> is refused.</li>
<li>You spawn with <strong>1 home planet</strong> (steadily produces metal &amp; fuel), <strong>2 starter ships</strong>
(<em>Vanguard</em>, <em>Harrier</em>) in <strong>1 fleet</strong>, and <strong>400 metal / 200 fuel</strong>.</li>
</ol>
<p>The camera starts centered on your home planet.</p>

<h2>Controls</h2>
<table>
<tr><th>Action</th><th>How</th></tr>
<tr><td>Pan the map</td><td>Drag with the mouse</td></tr>
<tr><td>Zoom</td><td>Mouse wheel (zooms toward the cursor)</td></tr>
<tr><td>Select</td><td>Click a planet, fleet, resource field, or wreck</td></tr>
<tr><td>Move a fleet</td><td>Select your fleet, then click empty space</td></tr>
<tr><td>Mine a field</td><td>Select your fleet, then click a <strong>resource field</strong> (amber cluster)</td></tr>
<tr><td>Salvage a wreck</td><td>Select your fleet, then click a <strong>♢ wreck</strong></td></tr>
<tr><td>Build a station</td><td>Select a resource field → <strong>Build mining station</strong></td></tr>
<tr><td>Center on home</td><td><strong>⌂ Home</strong> button or press <strong>H</strong></td></tr>
<tr><td>Fleets &amp; ships panel</td><td><strong>☰ Fleets</strong> button</td></tr>
<tr><td>Toggle sensor ranges / debug</td><td>Checkboxes (bottom-right)</td></tr>
</table>
<p>The top bar shows your <strong>metal / fuel</strong>, the <strong>⌂ Home</strong> and <strong>☰ Fleets</strong>
buttons, and connection status. The right panel is the <strong>inspector</strong> for whatever you have selected.
Energy is <strong>not</strong> a stored resource — it's a per-ship stat produced by reactors (cargo only holds physical commodities).</p>

<h2>The core loop</h2>
<p><strong>Mine &amp; expand economy → build ships → design them → form fleets → move → fight → repeat.</strong></p>

<h3>1. Economy</h3>
<p>Your home planet accumulates resources over real time (about <strong>+2.5 metal/s</strong> and <strong>+1.25 fuel/s</strong>).
Select your planet to see stored resources, rates, and the construction queue.</p>

<h3>2. Build ships</h3>
<p>Select your <strong>home planet</strong> → <strong>Build ship</strong> (costs <strong>120 metal + 40 fuel</strong>, ~8 s).
When it finishes, the ship is <strong>docked</strong> at your planet — open <strong>☰ Fleets</strong> to find it under
<strong>Docked ships</strong> and put it into a fleet.</p>

<h3>3. Design ships (Ship Builder)</h3>
<p>Select a fleet, then click a ship in the <strong>Ships</strong> list (or the <strong>✎</strong> on a roster row) to open the
<strong>Ship Builder</strong>. A ship is a rectangular <strong>hull grid</strong> filled with <strong>rooms</strong> (modules).
Every room has its own HP, so combat damage is local — losing a room removes exactly that capability.</p>
${shot("builder.png", "The ship builder: place modules on the hull grid; live derived stats on the right.")}
<h4>Module reference</h4>
<table>
<tr><th>Module</th><th>HP</th><th>Power</th><th>What it gives</th></tr>
<tr><td><strong>Bridge</strong></td><td>40</td><td>−2</td><td>Required (exactly one). +0.6 turn, +800 sensor</td></tr>
<tr><td><strong>Reactor</strong></td><td>30</td><td><strong>+10</strong></td><td>Generates power (scales with remaining HP)</td></tr>
<tr><td><strong>Engine</strong></td><td>30</td><td>−3</td><td>+90 thrust, +0.5 turn</td></tr>
<tr><td><strong>Shield</strong></td><td>25</td><td>−4</td><td>+60 shield capacity (stacks)</td></tr>
<tr><td><strong>Laser</strong></td><td>25</td><td>−3</td><td>8 dmg · 0.9 s cd · range 520 · fast shot</td></tr>
<tr><td><strong>Cannon</strong></td><td>28</td><td>−4</td><td>16 dmg · 1.6 s cd · range 380 · slow shot</td></tr>
<tr><td><strong>Storage</strong></td><td>35</td><td>0</td><td>+100 cargo capacity</td></tr>
<tr><td><strong>Mining Laser</strong></td><td>30</td><td>−6</td><td>+8 mining power (metal &amp; fuel), range 220</td></tr>
</table>
<p class="guide-note">Power is per-module: positive = produced, negative = consumed. A <strong>miner</strong> is any ship you fit with a
Mining Laser (to extract) and Storage (to hold ore).</p>
<h4>Derived stats</h4>
<ul>
<li><strong>Hull HP</strong> = <code>60 + width × height × 4</code>.</li>
<li><strong>Thrust</strong> → strategic speed &amp; combat maneuver. <strong>Turn rate</strong> from bridge + engines.</li>
<li><strong>Shield capacity</strong> (60 each) is your regenerating buffer (regen +4/s).</li>
<li><strong>Power</strong>: reactors produce (scaled by their HP); everything else demands. Only rooms that are enabled and HP&gt;0 contribute.</li>
<li><strong>Cargo</strong> = capacity; the carried contents (metal/fuel) show in the ship inspector. <strong>Mining power</strong> = sum of Mining Lasers.</li>
</ul>
<p><strong>Underpowered</strong> (demand &gt; production) is a warning, not an error — keep production ≥ demand as design discipline.</p>
<h4>How stats matter</h4>
<ul>
<li><strong>Strategic map:</strong> a ship's top speed ≈ <code>thrust × 2</code> (clamped 60–320); a <strong>fleet advances at its slowest ship's speed</strong> so it stays together.</li>
<li><strong>Combat:</strong> thrust = maneuver, shields = first defense, weapons = damage, every room is a target.</li>
</ul>

<h3>4. Managing fleets (☰ Fleets panel)</h3>
${shot("roster.png", "The Fleets panel: your fleets, docked ships, and create/add/split/merge controls.")}
<ul>
<li><strong>Create fleet</strong> — form a new fleet from checked ships. <strong>Add ▾</strong> — add checked ships to a chosen fleet.</li>
<li><strong>Split</strong> — check a subset then Create. <strong>Merge</strong> — check a whole fleet then Add to another (the emptied fleet disappears).</li>
<li><strong>⌖ locate</strong> — center on a fleet; <strong>✎</strong> opens a ship in the builder.</li>
</ul>

<h3>5. Move fleets</h3>
${shot("fleet.png", "A fleet flying to its anchor and holding formation.")}
<p>Click anywhere to drop the fleet's <strong>anchor</strong> — a static goal marker (crosshair + line). Ships fly to it and hold
formation, advancing at the slowest ship's speed. Ships are <em>always</em> simulated, so they're alive even with no enemy near, and
you can <strong>redirect at any time</strong> (including mid-fight). The fleet marker sits on the ships' <strong>centroid</strong>; the anchor is the destination.</p>

<h3>6. Encounters &amp; battle</h3>
${shot("combat.png", "Continuous combat happens right on the map — no separate battle screen.")}
<p>You sense the galaxy through your fleets' and planet's <strong>sensor range</strong> (kept tight). Inside a sensor bubble everything shows in
full — enemy ships included, in or out of a fight. Outside it, space is <strong>fogged</strong> and tracks your fleets/planets/stations.</p>
<blockquote><strong>Ships propose. The fleet decides. Ships execute.</strong> You command movement and orders; ships perceive and report;
a fleet brain decides whether to engage; ships fight autonomously.</blockquote>
<p><strong>Damage</strong> is systemic: shots hit <strong>shields</strong>, then a <strong>room</strong>, with overflow into the <strong>hull</strong>.
A room at 0 HP is disabled (weapon silent, thrust drops, reactor output falls); at 0 hull the ship is destroyed. Damage <strong>persists</strong>; the
whole sim is <strong>deterministic</strong> (seeded). Because it's the shared world, <strong>movement stays available during combat</strong> — kiting &amp; retreat are just movement.</p>

<h3>Fleet orders</h3>
<ul>
<li><strong>Move</strong> (click empty space) — go there; your order is obeyed even in combat.</li>
<li><strong>Attack-move</strong> (toggle, then click) — advance while engaging.</li>
<li><strong>Pursue</strong> (click an enemy fleet) — chase, holding a standoff ring at weapon range.</li>
<li><strong>Mine</strong> (click a field) / <strong>Salvage</strong> (click a wreck) — extract into cargo.</li>
<li><strong>Hold</strong> — stay put; ships still fight locally. <strong>Unload</strong> — dump cargo into a planet you're parked at.</li>
</ul>
<p>Pick a <strong>formation preset</strong> (column, line, wedge, echelon, box, screen, protect, loose). Presets place ships <strong>by role</strong> —
heavier ships forward in a wedge, valuable ships centered in <em>protect</em>.</p>
<h3>Doctrine</h3>
<p>Set how autonomously a fleet commits: <strong>Hold Fire</strong>, <strong>Return Fire</strong>, <strong>Attack on Sight</strong>, <strong>Pursue</strong>, <strong>Flee if Attacked</strong>.
Identical fleets behave very differently by preset — but your explicit <strong>move orders always override</strong> its aggression.</p>
<h3>Ship doctrine</h3>
<p>Each ship also has: <strong>Formation role</strong> (front/middle/rear), <strong>Preferred range</strong> (close/medium/long — pair with weapons; out of range = never fires),
and <strong>Target priority</strong> (nearest/small/large). Good builds + doctrine + positioning beat raw numbers.</p>

<h2>Mining &amp; logistics</h2>
<p>Real growth comes from <strong>physically extracting and hauling resources</strong>. Miners, haulers and their cargo are real objects that can be
scouted, escorted, raided, or blown up. <strong>The economy builds your military; the military protects the economy.</strong></p>
<h3>Resource fields</h3>
<p><strong>Resource fields</strong> (amber clusters) hold <strong>deposits</strong> with a <strong>resource</strong> (metal/fuel),
<strong>richness</strong> (~0.6–1.5× rate), <strong>reserves</strong> (deplete and can run dry), and <strong>accessibility</strong>. A rich field deep in
dangerous space can be worth <em>less</em> than a modest one near home — you still have to move the cargo out safely.</p>
<h3>Mining</h3>
<ol>
<li>Build a <strong>miner</strong> (Mining Laser + Storage).</li>
<li>Select the fleet, then <strong>click a resource field</strong>. Miners fly there and extract (watch cargo fill in the ship inspector); they shoot a mining beam while working. Rate ≈ <code>mining power × richness × accessibility</code>.</li>
<li>Mining stops when cargo is full, the deposit is exhausted, or you give a new order.</li>
<li>Fly home and press <strong>Unload</strong>; <strong>Transfer</strong> between nearby ships so miners needn't leave the field.</li>
</ol>
<h3>Automated operations</h3>
<p>Select a mining fleet → <strong>Auto-mine nearest field → home</strong>. It loops on its own: <strong>travel → mine → full → return → unload → repeat</strong>,
until you <strong>Stop</strong> it, the deposit runs dry, or the fleet dies.</p>
<h3>Mining stations</h3>
<p>Select a field → <strong>Build mining station</strong> (300 metal + 120 fuel). It <strong>auto-extracts</strong> into its own large storage and
<strong>projects sensor range</strong> over the field. A powerful asset — and a fat target, so keep a defensive fleet nearby.</p>
<h3>Logistics warfare &amp; salvage</h3>
<ul>
<li><strong>Commerce raiding</strong> — position a fleet on a hauler's route; normal combat does the rest.</li>
<li><strong>Wrecks &amp; salvage</strong> — every destroyed ship drops a <strong>♢ wreck</strong> (hull scrap + a fraction of its cargo). A nearby ship with free cargo auto-recovers it, or select a fleet and click the wreck to salvage.</li>
<li><strong>Calling for help</strong> — if a fleet running an operation is attacked, your nearest idle armed fleet is dispatched to intervene.</li>
</ul>

<h2>Tips</h2>
<ul>
<li>Match weapons to range doctrine: cannons need <code>close</code>, lasers poke from <code>long</code>.</li>
<li>Bring shields for long fights (regen is only +4/s). Spread weapons/engines so one hit can't cripple you.</li>
<li>Reactors scale with HP — bury them behind other rooms. Keep production ≥ demand.</li>
<li>Numbers count: outnumbering reliably wins even builds — combine good ships <em>and</em> positioning.</li>
<li>Automate the grind, guard the route: an unescorted laden ship is free resources (and salvage) for a raider.</li>
</ul>

<h2>What's not in this prototype</h2>
<p class="guide-note">No persistence, accounts, alliances, diplomacy, research trees, or marketplaces — the focus is the
<strong>mine → move → encounter → automatic modular combat</strong> loop and the physical economy that feeds it.</p>
`;

export class Guide {
  private overlay: HTMLDivElement;
  visible = false;

  constructor(root: HTMLElement) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);

    this.overlay = document.createElement("div");
    this.overlay.id = "guide-overlay";
    const inner = document.createElement("div");
    inner.className = "guide-inner";
    const close = document.createElement("button");
    close.id = "guide-close";
    close.textContent = "✕";
    close.title = "Close guide";
    close.addEventListener("click", () => this.close());
    inner.append(close);
    const content = document.createElement("div");
    content.innerHTML = BODY;
    inner.append(content);
    this.overlay.append(inner);
    root.append(this.overlay);

    // Click the dark backdrop (outside the content column) to close.
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close();
    });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.visible) this.close();
    });
  }

  open(): void {
    this.visible = true;
    this.overlay.style.display = "block";
    this.overlay.scrollTop = 0;
  }
  close(): void {
    this.visible = false;
    this.overlay.style.display = "none";
  }
  toggle(): void {
    this.visible ? this.close() : this.open();
  }
}
