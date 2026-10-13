        import {
            Labels, LabeledFrame, Instance, PredictedInstance,
            Skeleton, Node, Edge, Video, Track, saveSlpToBytes,
            readSlpStreaming,
            openSlpWriter, saveSlpMergedFromStores, saveSlpMergedToSink, SlpStreamWriter,
            Camera as SioCamera, CameraGroup, RecordingSession,
            InstanceGroup as SioInstanceGroup, FrameGroup as SioFrameGroup,
            Identity as SioIdentity, Instance3D, PredictedInstance3D,
            MediaBunnyVideoBackend
        } from './lib/sleap-io/index.browser.js?v=2e6c00f45e87';
        window.SleapIO = {
            Labels, LabeledFrame, Instance, PredictedInstance,
            Skeleton, Node, Edge, Video, Track, saveSlpToBytes,
            readSlpStreaming,
            openSlpWriter, saveSlpMergedFromStores, saveSlpMergedToSink, SlpStreamWriter,
            Camera: SioCamera, CameraGroup, RecordingSession,
            InstanceGroup: SioInstanceGroup, FrameGroup: SioFrameGroup,
            Identity: SioIdentity, Instance3D, PredictedInstance3D,
            MediaBunnyVideoBackend
        };
        window.dispatchEvent(new Event('sleapio-ready'));
    