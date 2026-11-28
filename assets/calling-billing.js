(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let auth = null;
  let user = null;
  function note(text, error) {
    const node = $('callingBillingMessage');
    if (!node) return;
    node.textContent = text || '';
    node.className = 'mt-3 text-sm ' + (error ? 'text-rose-300' : 'text-emerald-300');
  }
  async function request(method, body) {
    const response = await fetch(Englishmates.api('calling-billing'), {
      method, headers: { Authorization: 'Bearer ' + await user.getIdToken(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || 'Calling Community billing request failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }
  function paint(data) {
    if (!data || !$('callingPlan')) return;
    const used = Math.min(600, Number(data.usedSeconds || 0));
    const remaining = Math.max(0, Number(data.remainingSeconds ?? (600 - used)));
    const percent = Math.round((used / 600) * 100);
    $('callingUsageBar').style.width = percent + '%';
    $('callingUsageLabel').textContent = data.paidActive ? 'Monthly pass active · free minutes refresh daily too' : 'Today’s free audio: ' + Math.floor(remaining / 60) + ' min ' + (remaining % 60) + ' sec left';
    $('callingUsagePercent').textContent = data.paidActive ? 'PASS ACTIVE' : percent + '% used';
    const end = data.subscriptionEndsAt ? new Date(data.subscriptionEndsAt).toLocaleDateString() : '';
    $('callingPassStatus').textContent = data.paidActive ? 'Extended calling is unlocked until ' + end + '. This pass does not auto-renew.' : data.pendingReview ? 'Your UPI payment is waiting for admin verification.' : 'After today’s free 10 minutes, activate a 30-day pass for extended calls and rooms.';
    $('callingRazorpay').textContent = data.paidActive ? 'Extend pass · ₹299' : 'Unlock 30 days · ₹299';
    $('callingRazorpay').disabled = false;
  }
  async function refresh() {
    if (!user || !user.emailVerified) return;
    try { const data = await request('GET'); paint(data); }
    catch (error) { if (error.status !== 404) note(error.message, true); }
  }
  async function createRazorpay() {
    try {
      $('callingRazorpay').disabled = true;
      note('Preparing secure Razorpay checkout…');
      const order = await request('POST', { action: 'create-razorpay-order' });
      if (!window.Razorpay) throw new Error('Razorpay checkout could not load. Refresh the page and try again.');
      const checkout = new window.Razorpay({
        key: order.keyId, amount: order.amount, currency: order.currency, name: 'Englishmates',
        description: 'Calling Community · 30-day pass', order_id: order.orderId,
        prefill: { email: user.email || order.email || '' }, theme: { color: '#6d5dfc' },
        handler: async response => {
          try {
            note('Verifying your payment securely…');
            const verified = await request('POST', { action: 'verify-razorpay-payment', ...response });
            note(verified.message);
            await refresh();
          } catch (error) { note(error.message, true); }
        },
        modal: { ondismiss: () => $('callingRazorpay').disabled = false }
      });
      checkout.on('payment.failed', response => note(response.error?.description || 'Payment did not complete. No pass was activated.', true));
      checkout.open();
    } catch (error) {
      note(error.message, true);
      $('callingRazorpay').disabled = false;
    }
  }
  async function submitUpi() {
    try {
      const utr = $('callingUpiRef').value.trim();
      $('callingUpiSubmit').disabled = true;
      note('Sending your UPI reference for review…');
      const result = await request('POST', { action: 'submit-upi-proof', utr });
      note(result.message);
      $('callingUpiRef').value = '';
      await refresh();
    } catch (error) { note(error.message, true); }
    finally { $('callingUpiSubmit').disabled = false; }
  }
  window.addEventListener('calling-billing-status', event => paint(event.detail));
  window.addEventListener('calling-quota-exhausted', refresh);
  window.addEventListener('calling-billing-refresh', refresh);
  function start() {
    if (!firebase.apps.length) return;
    auth = firebase.auth();
    auth.onAuthStateChanged(next => {
      user = next;
      $('callingPlan').classList.toggle('hidden', !next || !next.emailVerified);
      if (next && next.emailVerified) refresh();
    });
    $('callingRazorpay').addEventListener('click', createRazorpay);
    $('callingUpiSubmit').addEventListener('click', submitUpi);
  }
  start();
})();
