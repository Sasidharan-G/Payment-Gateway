import process from 'node:process';

/**
 * Real mode (set by the Supabase entry point): VoicePay never pretends to hold or move money.
 *  - no wallet balance (your bank/UPI app is the source of truth)
 *  - people and shops are paid through the user's own UPI app
 *  - bills, bank transfers and wallet top-ups stay off until a real provider is connected
 *  - no demo gateway, no reset, no mandatory simulated KYC
 * Local development and the test-suite keep the demo behaviour.
 */
export const realMode = () => process.env.REAL_MODE === '1';
