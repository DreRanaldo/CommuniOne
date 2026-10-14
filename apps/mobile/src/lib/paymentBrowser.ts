// Opens the payment provider's hosted page (Stage E) in an in-app browser
// session that closes when the provider sends the customer back to the
// app's return link. Card details are entered on the provider's page only;
// the app never sees them. Returning tells the app to ASK THE SERVER for the
// payment status: it is not proof of payment.
import * as WebBrowser from 'expo-web-browser';

export interface PaymentBrowser {
  /** Resolves when the page returns to `returnUrl` ('returned') or the user closes it ('closed'). */
  open(url: string, returnUrl: string): Promise<'returned' | 'closed'>;
}

export const expoPaymentBrowser: PaymentBrowser = {
  async open(url, returnUrl) {
    const result = await WebBrowser.openAuthSessionAsync(url, returnUrl);
    return result.type === 'success' ? 'returned' : 'closed';
  },
};

/** The deep link the payment provider returns to (matches PAYMENTS_RETURN_URL). */
export const PAYMENT_RETURN_URL = 'communione://payment-return';
