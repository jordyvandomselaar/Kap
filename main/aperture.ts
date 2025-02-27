import {windowManager} from './windows/manager';
import {setRecordingTray, disableTray, resetTray} from './tray';
import {setCropperShortcutAction} from './global-accelerators';
import {settings} from './common/settings';
import {plugins} from './plugins';
import {getAudioDevices, getSelectedInputDeviceId} from './utils/devices';
import {showError} from './utils/errors';
import {RecordServiceContext, RecordServiceState} from './plugins/service-context';
import {setCurrentRecording, updatePluginState, stopCurrentRecording} from './recording-history';
import {Recording} from './video';
import {ApertureOptions, StartRecordingOptions} from './common/types';
import {InstalledPlugin} from './plugins/plugin';
import {RecordService, RecordServiceHook} from './plugins/service';

const createAperture = require('aperture');
const aperture = createAperture();

let recordingPlugins: Array<{plugin: InstalledPlugin; service: RecordService}> = [];
const serviceState = new Map<string, RecordServiceState>();
let apertureOptions: ApertureOptions;
let recordingName: string | undefined;
let past: number | undefined;

const setRecordingName = (name: string) => {
  recordingName = name;
};

const serializeEditPluginState = () => {
  const result: Record<string, Record<string, Record<string, unknown> | undefined>> = {};

  for (const {plugin, service} of recordingPlugins) {
    if (!result[plugin.name]) {
      result[plugin.name] = {};
    }

    result[plugin.name][service.title] = serviceState.get(service.title)?.persistedState;
  }

  return result;
};

const callPlugins = async (method: RecordServiceHook) => Promise.all(recordingPlugins.map(async ({plugin, service}) => {
  if (service[method] && typeof service[method] === 'function') {
    try {
      await service[method]?.(
        new RecordServiceContext({
          plugin,
          apertureOptions,
          state: serviceState.get(service.title) ?? {},
          setRecordingName
        })
      );
    } catch (error) {
      showError(error as any, {title: `Something went wrong while using the plugin “${plugin.prettyName}”`, plugin});
    }
  }
}));

const cleanup = async () => {
  windowManager.cropper?.close();
  resetTray();

  await callPlugins('didStopRecording');
  serviceState.clear();

  setCropperShortcutAction();
};

export const startRecording = async (options: StartRecordingOptions) => {
  if (past) {
    return;
  }

  past = Date.now();
  recordingName = undefined;

  windowManager.preferences?.close();
  windowManager.cropper?.disable();
  disableTray();

  const {cropperBounds, screenBounds, displayId} = options;

  cropperBounds.y = screenBounds.height - (cropperBounds.y + cropperBounds.height);

  const {
    record60fps,
    showCursor,
    highlightClicks,
    recordAudio
  } = settings.store;

  apertureOptions = {
    fps: record60fps ? 60 : 30,
    cropArea: cropperBounds,
    showCursor,
    highlightClicks,
    screenId: displayId
  };

  if (recordAudio) {
    // In case for some reason the default audio device is not set
    // use the first available device for recording
    const audioInputDeviceId = getSelectedInputDeviceId();
    if (audioInputDeviceId) {
      apertureOptions.audioDeviceId = audioInputDeviceId;
    } else {
      const [defaultAudioDevice] = await getAudioDevices();
      apertureOptions.audioDeviceId = defaultAudioDevice?.id;
    }
  }

  // TODO: figure out how to correctly process hevc videos with ffmpeg
  // if (recordHevc) {
  //   apertureOptions.videoCodec = 'hevc';
  // }

  console.log(`Collected settings after ${(Date.now() - past) / 1000}s`);

  recordingPlugins = plugins
    .recordingPlugins
    .flatMap(
      plugin => {
        const validServices = plugin.config.validServices;
        return plugin.recordServicesWithStatus
          // Make sure service is valid and enabled
          .filter(({title, isEnabled}) => isEnabled && validServices.includes(title))
          .map(service => ({plugin, service}));
      }
    );

  for (const {service, plugin} of recordingPlugins) {
    serviceState.set(service.title, {persistedState: {}});
    console.log(`plugins/used/record/${plugin.name}`);
  }

  await callPlugins('willStartRecording');

  try {
    const filePath = await aperture.startRecording(apertureOptions);

    setCurrentRecording({
      filePath,
      name: recordingName,
      apertureOptions,
      plugins: serializeEditPluginState()
    });
  } catch (error) {
    console.log('recording/stopped/error');
    showError(error as any, {title: 'Recording error', plugin: undefined});
    past = undefined;
    cleanup();
    return;
  }

  const startTime = (Date.now() - past) / 1000;
  if (startTime > 3) {
    console.log(`recording/started/${startTime}`);
  } else {
    console.log('recording/started');
  }

  console.log(`Started recording after ${startTime}s`);
  windowManager.cropper?.setRecording();
  setRecordingTray(stopRecording);
  setCropperShortcutAction(stopRecording);
  past = Date.now();

  // Track aperture errors after recording has started, to avoid kap freezing if something goes wrong
  aperture.recorder.catch((error: any) => {
    // Make sure it doesn't catch the error of ending the recording
    if (past) {
      console.log('recording/stopped/error');
      showError(error, {title: 'Recording error', plugin: undefined});
      past = undefined;
      cleanup();
    }
  });

  await callPlugins('didStartRecording');
  updatePluginState(serializeEditPluginState());
};

export const stopRecording = async () => {
  // Ensure we only stop recording once
  if (!past) {
    return;
  }

  console.log(`Stopped recording after ${(Date.now() - past) / 1000}s`);
  past = undefined;

  let filePath;

  try {
    filePath = await aperture.stopRecording();
  } catch (error) {
    console.log('recording/stopped/error');
    showError(error as any, {title: 'Recording error', plugin: undefined});
    cleanup();
    return;
  }

  try {
    cleanup();
  } finally {
    console.log('editor/opened/recording');

    const recording = new Recording({
      filePath,
      title: recordingName,
      apertureOptions
    });
    await recording.openEditorWindow();

    stopCurrentRecording(recordingName);
  }
};
