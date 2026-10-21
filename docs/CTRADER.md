# cTrader Open API integration notes

## Verified (2026-10-21)
- `wss://demo.ctraderapi.com:5036` and `wss://live.ctraderapi.com:5036` accept JSON over WebSocket.
  `{"clientMsgId":"v1","payloadType":2104,"payload":{}}` → `{"payloadType":2105,"clientMsgId":"v1","payload":{"version":"102"}}` (~0.8 s).
- Works from workerd: `fetch("https://demo.ctraderapi.com:5036", { headers: { Upgrade: "websocket" } })` → `resp.webSocket`, then `ws.accept()`.

## Protocol (from help.ctrader.com — verify payloadType numbers/enums/fields against the official proto files:
## https://github.com/spotware/openapi-proto-messages  OpenApiMessages.proto, OpenApiModelMessages.proto, OpenApiCommonMessages.proto)
- Envelope: `{ clientMsgId: string, payloadType: number, payload: {...} }`. Responses echo clientMsgId; events (execution, spot) may arrive without it.
- Heartbeat: send `ProtoHeartbeatEvent` (payloadType 51) every 10 s if a session lives that long.
- Session: ProtoOAApplicationAuthReq {clientId, clientSecret} → ProtoOAAccountAuthReq {ctidTraderAccountId, accessToken} → requests.
  Account list: ProtoOAGetAccountListByAccessTokenReq {accessToken} → ctidTraderAccount[] (ctidTraderAccountId, isLive, traderLogin, brokerTitleShort…). Requires app auth first.
- Errors: ProtoOAErrorRes {errorCode, description}; ProtoOAOrderErrorEvent {errorCode, description, orderId?, positionId?}.
- ProtoOANewOrderReq: ctidTraderAccountId, symbolId, orderType (MARKET/LIMIT/STOP…), tradeSide (BUY/SELL), volume (**0.01 of a unit**),
  limitPrice, stopPrice, stopLoss/takeProfit (absolute; check whether allowed for MARKET), relativeStopLoss/relativeTakeProfit
  (**1/100000 of price unit**; for MARKET), comment (≤512), label (≤100). Result: ProtoOAExecutionEvent {executionType, position, order, deal}.
- Lots → volume: volume = lots × symbol.lotSize (lotSize is also in 0.01 units, from ProtoOASymbolByIdReq). Respect minVolume/stepVolume/maxVolume.
- Spot prices (ProtoOASpotEvent bid/ask) are in 1/100000 of price unit. Symbol `digits` gives display precision.
- Money values (balance etc.) are integers scaled by `moneyDigits` (10^moneyDigits).
- Positions/orders: ProtoOAReconcileReq → position[] (tradeData{symbolId, volume, tradeSide, openTimestamp, label, comment}, price, stopLoss, takeProfit, swap, commission, moneyDigits), order[].
- Close: ProtoOAClosePositionReq {positionId, volume}. Amend SL/TP: ProtoOAAmendPositionSLTPReq {positionId, stopLoss, takeProfit}.
- Rate limits: 50 req/s per connection (non-historical), 5 req/s historical.

## OAuth
- Authorize: `https://id.ctrader.com/my/settings/openapi/grantingaccess/?client_id=…&redirect_uri=…&scope=trading&product=web` (+ our `state`).
- Token: `GET https://openapi.ctrader.com/apps/token?grant_type=authorization_code&code=…&redirect_uri=…&client_id=…&client_secret=…`
  → `{ accessToken, tokenType, expiresIn (≈2,628,000 s ≈ 30 days), refreshToken, errorCode, description }`. Code expires in 1 minute.
- Refresh: same endpoint, `grant_type=refresh_token&refresh_token=…&client_id=…&client_secret=…`. Refresh token does not expire.
- The redirect URI `https://trading.infragreen.app/api/ctrader/callback` must be registered on the Open API application (openapi.ctrader.com → Applications).
