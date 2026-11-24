/**
 * Shared by the Training panel e2e tests: a two-view session (cam1, cam2; 12-frame mp4 each)
 * loaded with "Load session folder (per camera)", with a USER instance on frames 0-5 of each view
 * and a prediction on frame 7, then the Training panel's label analysis refreshed.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{views: string[]}>}
 */
export function loadTrainingSession(page) {
    return page.evaluate(async () => {
        const enc = await import('./ui/video-encode.js');
        const fio = await import('./import-export/file-io.js');
        const pd = await import('./pose/pose-data.js');
        const loader = await import('./loading/session-loader.js');
        const AS = await import('./ui/app-state.js');
        const CAMS = ['cam1', 'cam2'], W = 320, H = 240, N = 12, ROOT = 'rec';
        async function mp4(shade) {
            const canvas = document.createElement('canvas');
            canvas.width = W; canvas.height = H;
            const c = canvas.getContext('2d');
            const wr = await enc.createMp4Writer({ canvas, width: W, height: H, fps: 10, bitrate: 300000, frameCount: N, keyFrameEveryFrames: 4 });
            for (let i = 0; i < N; i++) { c.fillStyle = 'rgb(' + shade + ',' + (10 * i) + ',80)'; c.fillRect(0, 0, W, H); await wr.addFrame(i); }
            return (await wr.finish()).blob;
        }
        let toml = '';
        CAMS.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [' + W + ', ' + H + ']\n'
                + 'matrix = [[600.0, 0.0, 160.0], [0.0, 600.0, 120.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\nrotation = [0.0, ' + (0.2 * i) + ', 0.0]\n'
                + 'translation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        function mkFile(bits, rel, type) {
            const f = new File(bits, rel.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: rel });
            return f;
        }
        async function slp(cam) {
            const K = [[600, 0, 160], [0, 600, 120], [0, 0, 1]];
            const cams = CAMS.map((n, i) => new pd.Camera(n, K, [0, 0, 0, 0, 0], [0, 0.2 * i, 0], [15 * i, 0, 0], [W, H]));
            const s = new pd.Session(cams, new pd.Skeleton('sk', ['A', 'B'], [[0, 1]]), ['t0'], 'gen');
            for (let f = 0; f < 6; f++) {
                const fg = new pd.FrameGroup(f); s.addFrameGroup(fg);
                fg.addInstance(cam, new pd.Instance([[11 + f, 22], [33 + f, 44]], 0, 'user', 1));
            }
            const f7 = new pd.FrameGroup(7); s.addFrameGroup(f7);
            f7.addInstance(cam, new pd.Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5));
            return fio.exportSlpClientSide(s, cam, false, { videoPath: ROOT + '/' + cam + '/' + cam + '.mp4', file: null,
                videoWidth: W, videoHeight: H, frameCount: N }, cam + '.slp', null);
        }
        const v1 = await mp4(10), v2 = await mp4(200);
        const files = [mkFile([toml], ROOT + '/calibration.toml', 'text/plain'),
            mkFile([v1], ROOT + '/cam1/cam1.mp4', 'video/mp4'), mkFile([v2], ROOT + '/cam2/cam2.mp4', 'video/mp4'),
            mkFile([await slp('cam1')], ROOT + '/cam1/cam1.slp'), mkFile([await slp('cam2')], ROOT + '/cam2/cam2.slp')];
        AS.state.sessions = []; AS.state.activeSessionIdx = 0; AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        await loader.handleLoadSessionFolderPerCamera(files, false);
        (await import('./ui/training-panel.js'))._trainingAnalyze();
        return { views: AS.state.views.map((v) => v.name) };
    });
}
