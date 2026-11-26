export const desktopModel = 'bs-roformer-sw-6-v1';
export const mobileModel = 'htdemucs-6s-3.9-v1';

export function preferredModel(device) {
  const mobile = device.userAgentData?.mobile || /Android|iPhone|iPad|iPod/i.test(device.userAgent)
    || (/Mac/i.test(device.platform) && device.maxTouchPoints > 1);
  return mobile || (device.deviceMemory > 0 && device.deviceMemory <= 4) ? mobileModel : desktopModel;
}
