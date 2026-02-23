1. frontend/src/services/input-validation-schemas.ts
Comment on lines +154 to +165
    const MESSAGE_MAP: Partial<Record<string, string>> = {
      'Game ID is required': 'Round ID is required',
      'Game ID must be a valid integer': 'Round ID must be a valid integer',
      'Game ID must be non-negative': 'Round ID must be non-negative',
    };
    return {
      success: false,
      error: {
        ...result.error,
        field: 'roundId',
        message: MESSAGE_MAP[result.error.message] ?? result.error.message,
      },
@coderabbitai
coderabbitai bot
2 minutes ago
⚠️ Potential issue | 🟡 Minor

Fragile message-key coupling in MESSAGE_MAP — prefer error-code keys.

MESSAGE_MAP is keyed on exact string literals from validateGameId. If that function ever renames its messages, the fallback (?? result.error.message) silently leaks "Game ID is required" (etc.) to consumers of validateRoundId. Using ValidationErrorCode values as keys is enum-stable and immune to upstream message drift:

♻️ Proposed refactor
-    const MESSAGE_MAP: Partial<Record<string, string>> = {
-      'Game ID is required': 'Round ID is required',
-      'Game ID must be a valid integer': 'Round ID must be a valid integer',
-      'Game ID must be non-negative': 'Round ID must be non-negative',
-    };
+    const MESSAGE_BY_CODE: Partial<Record<ValidationErrorCode, string>> = {
+      [ValidationErrorCode.Required]:    'Round ID is required',
+      [ValidationErrorCode.InvalidType]: 'Round ID must be a valid integer',
+      [ValidationErrorCode.OutOfRange]:  'Round ID must be non-negative',
+    };
     return {
       success: false,
       error: {
         ...result.error,
         field: 'roundId',
-        message: MESSAGE_MAP[result.error.message] ?? result.error.message,
+        message: MESSAGE_BY_CODE[result.error.code] ?? result.error.message,
       },
     };


2. frontend/src/services/input-validation-schemas.ts
Comment on lines +380 to +383

  const addressResult = validateStellarAddress(input.walletAddress);
  if (!addressResult.success) return addressResult;

@coderabbitai
coderabbitai bot
2 minutes ago
⚠️ Potential issue | 🟡 Minor

validateStellarAddress errors surface as field: 'address', not 'walletAddress'.

parseCoinFlipBet (and parsePatternSubmission at line 441, parsePrizePoolPayout at line 573) returns the addressResult / recipientResult from validateStellarAddress unchanged. That validator emits field: 'address', while the input properties are walletAddress and recipient. All other field-name mismatches in this module are remapped (e.g. 'hash'→'commitmentHash', 'wager'→'amount'), so the omission here is inconsistent and will cause consumers keying on the input property name to silently miss address errors.

🐛 Proposed fix (apply the same pattern to all three sites)
// parseCoinFlipBet (line ~382)
-  const addressResult = validateStellarAddress(input.walletAddress);
-  if (!addressResult.success) return addressResult;
+  const addressResult = validateStellarAddress(input.walletAddress);
+  if (!addressResult.success) {
+    return { success: false, error: { ...addressResult.error, field: 'walletAddress' } };
+  }
// parsePatternSubmission (line ~441)
-  const addressResult = validateStellarAddress(input.walletAddress);
-  if (!addressResult.success) return addressResult;
+  const addressResult = validateStellarAddress(input.walletAddress);
+  if (!addressResult.success) {
+    return { success: false, error: { ...addressResult.error, field: 'walletAddress' } };
+  }
// parsePrizePoolPayout (line ~572)
-  const recipientResult = validateStellarAddress(input.recipient);
-  if (!recipientResult.success) return recipientResult;
+  const recipientResult = validateStellarAddress(input.recipient);
+  if (!recipientResult.success) {
+    return { success: false, error: { ...recipientResult.error, field: 'recipient' } };
+  }

3. frontend/tests/unit/input-validation-schemas.test.ts
Comment on lines +43 to +44
const VALID_WALLET = 'GABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2';
const VALID_CONTRACT = 'CABCDEFGHJKLMNPQRSTUVWXYZ234567ABCDEFGHJKLMNPQRSTUVWXYZ2';
@coderabbitai
coderabbitai bot
2 minutes ago
⚠️ Potential issue | 🟡 Minor

🧩 Analysis chain
Address validators perform format-only checks, not Stellar SDK checksum validation—but this creates a maintenance risk.

validateStellarAddress and validateContractAddress check only the prefix, length (56 chars), and base32 character set [A-Z2-7]{56}; they do not call StrKey.isValidEd25519PublicKey or StrKey.isValidContract, which would validate CRC-16/XModem checksums. The test fixtures pass these format checks, but they likely lack valid checksums and would fail actual Stellar SDK validation. If the codebase is upgraded to use full StrKey validation in the future, every address-dependent test in this suite will silently break.

4. frontend/tests/unit/input-validation-schemas.test.ts
Comment on lines +365 to +369
  it('fails when walletAddress is null', () => {
    const result = parseCoinFlipBet({ ...validInput, walletAddress: null });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.field).toBe('address');
  });
@coderabbitai
coderabbitai bot
2 minutes ago
⚠️ Potential issue | 🟡 Minor

Test documents the 'address' field name — update alongside the implementation fix.

Line 368 asserts result.error.field === 'address'. If the field-remapping fix suggested in parseCoinFlipBet (and parsePatternSubmission / parsePrizePoolPayout) is applied, this assertion should be updated to 'walletAddress'.