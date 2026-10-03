"""Einrichtung & Optionen (Aufräum-Tag, Uhrzeit, Mindestalter)."""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import (
    BooleanSelector,
    NumberSelector,
    NumberSelectorConfig,
    NumberSelectorMode,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
    TimeSelector,
)

from .const import (
    CONF_CLEANUP_TIME,
    CONF_CLEANUP_WEEKDAY,
    CONF_MIN_AGE_DAYS,
    CONF_SIDEBAR,
    DEFAULT_OPTIONS,
    DOMAIN,
    WEEKDAYS_DE,
)


def _schema(values: dict[str, Any]) -> vol.Schema:
    return vol.Schema(
        {
            vol.Required(
                CONF_CLEANUP_WEEKDAY, default=str(values[CONF_CLEANUP_WEEKDAY])
            ): SelectSelector(
                SelectSelectorConfig(
                    options=[
                        SelectOptionDict(value=str(n), label=day)
                        for n, day in enumerate(WEEKDAYS_DE)
                    ],
                    mode=SelectSelectorMode.DROPDOWN,
                )
            ),
            vol.Required(CONF_CLEANUP_TIME, default=values[CONF_CLEANUP_TIME]): TimeSelector(),
            vol.Required(CONF_MIN_AGE_DAYS, default=values[CONF_MIN_AGE_DAYS]): NumberSelector(
                NumberSelectorConfig(
                    min=0, max=60, step=1, mode=NumberSelectorMode.BOX, unit_of_measurement="Tage"
                )
            ),
            vol.Optional(CONF_SIDEBAR, default=bool(values.get(CONF_SIDEBAR, False))): BooleanSelector(),
        }
    )


def _normalize(user_input: dict[str, Any]) -> dict[str, Any]:
    return {
        CONF_CLEANUP_WEEKDAY: int(user_input[CONF_CLEANUP_WEEKDAY]),
        CONF_CLEANUP_TIME: str(user_input[CONF_CLEANUP_TIME]),
        CONF_MIN_AGE_DAYS: int(user_input[CONF_MIN_AGE_DAYS]),
        CONF_SIDEBAR: bool(user_input.get(CONF_SIDEBAR, False)),
    }


class EinkaufslisteConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if self._async_current_entries():
            return self.async_abort(reason="single_instance_allowed")
        if user_input is not None:
            return self.async_create_entry(
                title="Einkaufsliste", data={}, options=_normalize(user_input)
            )
        return self.async_show_form(step_id="user", data_schema=_schema(DEFAULT_OPTIONS))

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return EinkaufslisteOptionsFlow()


class EinkaufslisteOptionsFlow(OptionsFlow):
    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        manager = self.hass.data.get(DOMAIN, {}).get("manager")
        if user_input is not None:
            if user_input.get("reset_pin") and manager is not None:
                manager.clear_pin()  # 🔒 PIN vergessen? Hier setzt ein Admin sie zurück
            return self.async_create_entry(data=_normalize(user_input))
        values = {**DEFAULT_OPTIONS, **self.config_entry.options}
        values = {k: values[k] for k in DEFAULT_OPTIONS}
        schema = _schema(values)
        if manager is not None and manager.pin_hash:
            schema = schema.extend({vol.Optional("reset_pin", default=False): BooleanSelector()})
        return self.async_show_form(step_id="init", data_schema=schema)
