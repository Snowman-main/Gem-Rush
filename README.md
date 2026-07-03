# 💎 GEM RUSH

A fast multiplayer top-down arena game you play in the browser with friends.

## How a session works

1. **Create a party** — you get a 4-letter room code; friends enter it to join.
2. Everyone lands on the **party screen**: pick your name, ability, and color (FFA only).
   The **host** picks the mode (Free-for-all / 2 Teams / 4 Teams) and can move players
   between teams with the ⇄ buttons. Teams can only be changed here, never mid-game.
3. Host hits **START GAME**. When the game ends, everyone returns to the party screen.
4. In-game **↩ LEAVE** button: you go back to the party while the match keeps running
   (as long as 2+ players remain). If the **host** leaves, the match ends for everyone.

## The objective

- Gems spawn in the **mine circle** in the center of the arena.
- Walk over gems to pick them up.
- **FFA:** first player to hold **10 gems** through a 10-second countdown wins.
- **Teams:** your team's *combined* gems count. The countdown only runs while your team
  is strictly ahead — if another team ties the top count, it cancels until someone
  is uniquely in the lead again.
- Get shot down and you **drop every gem you're carrying** for others to steal.
- Carrying lots of gems slows you down slightly — risk vs. reward.
- Team modes have no friendly fire; teams share one color.

## How to run

```
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

## Playing with friends

**Same wifi (easiest):**
1. Run `ipconfig` in a terminal and find your **IPv4 Address** (e.g. `192.168.1.42`).
2. Friends open `http://YOUR-IP:3000` in their browser.
3. Create a room, share the 4-letter code, they hit JOIN.
   (If it doesn't load, allow Node.js through Windows Firewall when prompted.)

**Over the internet (friends anywhere):**
- Easiest: run a free tunnel while your server is running:
  ```
  npx localtunnel --port 3000
  ```
  Share the URL it prints. (Or use `cloudflared tunnel --url http://localhost:3000` if you have cloudflared.)
- Permanent: deploy this folder to a free Node host like Render or Railway —
  it's a single `npm start` app, no config needed.

## Controls

| Action | Key |
|---|---|
| Move | WASD or arrow keys |
| Aim | Mouse |
| Shoot | Left click (hold for auto-fire) |
| Ability | Right click or F |

## Abilities (pick one in the lobby)

| Ability | What it does | Cooldown |
|---|---|---|
| ⚡ Dash | Quick burst of speed in your movement direction | 2.5s |
| 💣 Blast | Lob a bomb over walls — 35 dmg, huge knockback + longer stun | 5s |
| 🛡 Shield | Block all bullets & bombs for 1.5s — usable **while stunned** | 6s |
| 👻 Ghost | Near-invisible + 25% faster for 2.5s; hidden from the minimap; shooting reveals you | 7s |

All abilities are free — cooldown is the only cost.

## Combat mechanics

- 100 HP, each hit deals 20 (5 hits to down someone)
- **Knockback + stun:** every hit launches the target back and stuns them for ~0.27s —
  they can't move (but can still shoot). Land shots back-to-back to **combo** people.
- **Regen:** stay out of combat for 4 seconds and your HP recovers
- **Spawn shield:** ~2s of invulnerability after spawning (ends early if you shoot)
- 3-second respawn, you spawn away from enemies
- Up to 10 players per room; new round starts automatically 8s after a win
