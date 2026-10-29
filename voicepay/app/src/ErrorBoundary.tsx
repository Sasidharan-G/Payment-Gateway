// Last line of defence: if any screen crashes, the user (who may be blind) hears what happened and gets
// one huge button to start again, instead of a frozen or blank app.
import React from 'react';
import { Pressable, Text, View } from 'react-native';
import * as Speech from 'expo-speech';

const MESSAGE = 'Something went wrong in the app. Your money is safe. Tap anywhere on the screen to start again.';

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  componentDidCatch(error: Error) {
    console.error('[app crash]', error?.message);
    try { Speech.speak(MESSAGE, { language: 'en-IN' }); } catch { /* speech is best effort */ }
  }

  restart = () => { Speech.stop(); this.setState({ failed: false }); };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Pressable
        onPress={this.restart}
        accessibilityRole="button"
        accessibilityLabel="Something went wrong. Double tap to start again."
        style={{ flex: 1, backgroundColor: '#05070A', alignItems: 'center', justifyContent: 'center', padding: 32 }}
      >
        <View style={{ width: 120, height: 120, borderRadius: 60, backgroundColor: '#F5B83D', alignItems: 'center', justifyContent: 'center', marginBottom: 32 }}>
          <Text style={{ fontSize: 64, color: '#05070A', fontWeight: '800' }}>!</Text>
        </View>
        <Text style={{ color: '#F5F7FA', fontSize: 26, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>Something went wrong</Text>
        <Text style={{ color: '#C3CAD3', fontSize: 18, textAlign: 'center', marginBottom: 32 }}>Your money is safe. Tap anywhere to start again.</Text>
        <View style={{ minHeight: 64, minWidth: 220, borderRadius: 32, backgroundColor: '#3DDC97', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
          <Text style={{ color: '#05070A', fontSize: 20, fontWeight: '700' }}>Start again</Text>
        </View>
      </Pressable>
    );
  }
}
