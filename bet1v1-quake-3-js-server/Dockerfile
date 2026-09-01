FROM lukaklacar/q3js-server:1.0.0

COPY --chown=q3js:q3js bet1v1-wrapper.mjs /opt/q3js/server/app/bet1v1-wrapper.mjs

ENTRYPOINT ["node", "app/bet1v1-wrapper.mjs"]
