import {
  Camera,
  CameraGroup,
  Edge,
  FrameGroup,
  Identity,
  Instance,
  Instance3D,
  InstanceGroup,
  LabeledFrame,
  Labels,
  MediaBunnyVideoBackend,
  Node,
  PredictedInstance,
  PredictedInstance3D,
  RecordingSession,
  Skeleton,
  SlpStreamWriter,
  Track,
  Video,
  openSlpWriter,
  readSlpStreaming,
  saveSlpMergedFromStores,
  saveSlpMergedToSink,
  saveSlpToBytes
} from "./chunk-ZJM2GJHK.js?v=2e6c00f45e87";
import "./chunk-E74SQL4U.js?v=2e6c00f45e87";
import "./chunk-RRGO6PLB.js?v=2e6c00f45e87";

// bridge.js
window.SleapIO = {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Node,
  Edge,
  Video,
  Track,
  saveSlpToBytes,
  readSlpStreaming,
  openSlpWriter,
  saveSlpMergedFromStores,
  saveSlpMergedToSink,
  SlpStreamWriter,
  Camera,
  CameraGroup,
  RecordingSession,
  InstanceGroup,
  FrameGroup,
  Identity,
  Instance3D,
  PredictedInstance3D,
  MediaBunnyVideoBackend
};
window.dispatchEvent(new Event("sleapio-ready"));
