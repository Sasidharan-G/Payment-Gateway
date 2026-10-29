// Scan a shop / person QR code. Made for people who cannot see the camera preview:
// it speaks guidance, repeats a hint while nothing is found, gives a haptic buzz when it finds a code,
// and gives up politely after a minute. A big Cancel button is always there.
import React, { useEffect, useRef, useState } from 'react';
import { Linking, Modal, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Text, Btn, Icon, buzz } from './ui';
import { useVoice } from './voice';
import { C, F, R, S } from './theme';

const HINTS = [
  'Still searching. Move the phone a little closer to the QR code.',
  'Try moving the phone a little farther away, and hold it steady.',
  'Make sure the QR code is well lit and fully inside the camera view.',
  'Tilt the phone slightly. Keep the camera facing the QR code.',
];
const GIVE_UP_MS = 60_000;

export default function QrScanner(props: {
  visible: boolean;
  /** True when the user asked for the camera by tapping (a voice command already spoke the intro). */
  announce?: boolean;
  onResult: (text: string) => void;
  onClose: (reason: 'cancelled' | 'timeout' | 'denied') => void;
}) {
  const voice = useVoice();
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const [perm, requestPerm] = useCameraPermissions();
  const done = useRef(false);
  const [asked, setAsked] = useState(false);

  // Ask for the camera once, and say why.
  useEffect(() => {
    if (!props.visible) { setAsked(false); return; }
    done.current = false;
    if (perm?.granted || asked) return;
    setAsked(true);
    (async () => {
      voiceRef.current.halt();
      if (props.announce) await voiceRef.current.speak('I need to use the camera to read the QR code. Please allow camera access.');
      const r = await requestPerm();
      if (!r.granted) {
        await voiceRef.current.speak('Camera access was not allowed. You can allow it in the phone settings, or pay by voice instead.');
        props.onClose('denied');
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, perm?.granted]);

  // Spoken guidance while the camera is searching.
  useEffect(() => {
    if (!props.visible || !perm?.granted) return;
    voiceRef.current.halt();
    if (props.announce) voiceRef.current.speak('Camera is open. Hold your phone about a foot from the QR code and move it slowly.');
    let n = 0;
    const hint = setInterval(() => {
      if (done.current) return;
      buzz('warn');
      voiceRef.current.speak(HINTS[n++ % HINTS.length]);
    }, 7000);
    const giveUp = setTimeout(async () => {
      if (done.current) return;
      done.current = true;
      await voiceRef.current.speak('I could not find a QR code. Closing the camera. You can try again, or pay by voice.');
      props.onClose('timeout');
    }, GIVE_UP_MS);
    return () => { clearInterval(hint); clearTimeout(giveUp); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.visible, perm?.granted]);

  const found = (data: string) => {
    if (done.current) return;
    done.current = true;
    buzz('success');
    voiceRef.current.halt();
    props.onResult(data);
  };

  return (
    <Modal visible={props.visible} animationType="slide" onRequestClose={() => { done.current = true; props.onClose('cancelled'); }}>
      <View accessibilityViewIsModal style={{ flex: 1, backgroundColor: C.bg, padding: S.md, paddingTop: 40 }}>
        <Text accessibilityRole="header" style={{ color: C.text, fontSize: F.h1, fontWeight: '800', textAlign: 'center' }}>Scan QR code</Text>
        <Text style={{ color: C.sub, fontSize: F.body, textAlign: 'center', marginVertical: S.sm }}>
          Hold the phone about a foot from the code. I will beep and speak when I find it.
        </Text>

        <View
          importantForAccessibility="no-hide-descendants"
          style={{ flex: 1, borderRadius: R.lg, overflow: 'hidden', borderWidth: 3, borderColor: C.green, backgroundColor: '#000' }}
        >
          {perm?.granted ? (
            <CameraView
              style={{ flex: 1 }}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={(e) => found(e.data)}
            />
          ) : (
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: S.lg }}>
              <Icon name="camera" size={64} color={C.sub} />
              <Text style={{ color: C.sub, fontSize: F.body, textAlign: 'center', marginTop: S.md }}>
                {perm && !perm.canAskAgain ? 'Camera access is off. Turn it on in the phone settings.' : 'Waiting for camera access…'}
              </Text>
              {perm && !perm.canAskAgain ? <Btn title="Open settings" icon="settings" kind="ghost" onPress={() => Linking.openSettings()} style={{ marginTop: S.md }} /> : null}
            </View>
          )}
        </View>

        <Btn title="Cancel" icon="close" kind="danger" onPress={() => { done.current = true; voiceRef.current.halt(); props.onClose('cancelled'); }} style={{ marginTop: S.md }} />
      </View>
    </Modal>
  );
}
