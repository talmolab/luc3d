/**
 * The one place a figs/ node driver learns which LUC3D it runs (LUC3D-JS plan R1, R4).
 *
 * POSE_DIR (or LUCID_ROOT) is REQUIRED. There is no default: a default once pointed at
 * ../lucid-bundle-adj and the eric/figs working tree, so a run without the variable
 * silently measured some other code. The checkout must be at v1.0.5 and clean, or the
 * driver refuses to start. `stamp` is what every deposit records.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const V105 = '2dc001fe527c4dbaad17fa171da132cfdfe010e6';

export function lucidPose() {
    const env = process.env.POSE_DIR
        || (process.env.LUCID_ROOT && path.join(process.env.LUCID_ROOT, 'pose'));
    if (!env) throw new Error('POSE_DIR (or LUCID_ROOT) is required: point it at the LUC3D v1.0.5 checkout');
    const poseDir = path.resolve(env);
    if (!fs.existsSync(poseDir)) throw new Error(`no pose dir at ${poseDir}`);
    const git = (...a) => execFileSync('git', ['-C', poseDir, ...a], { encoding: 'utf8' }).trim();
    const lucidRoot = git('rev-parse', '--show-toplevel');
    const lucidCommit = git('rev-parse', 'HEAD');
    if (lucidCommit !== V105) {
        throw new Error(`${lucidRoot} is at ${lucidCommit}, not LUC3D v1.0.5 (${V105})`);
    }
    if (git('status', '--porcelain', '--untracked-files=no')) {
        throw new Error(`${lucidRoot} has local changes`);
    }
    return { poseDir, stamp: { lucid_root: lucidRoot, lucid_commit: lucidCommit, pose_dir: poseDir } };
}
