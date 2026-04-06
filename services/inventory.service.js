const toNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const roundCurrency = (value) => Number(toNumber(value).toFixed(2));
const roundQty = (value) => Number(toNumber(value).toFixed(3));

const normalizePercent = (value, fallback = 0) => {
  const num = toNumber(value, fallback);
  if (num > 1) return num / 100;
  return num;
};

const calculateBatchCosts = (payload = {}) => {
  const quantity = toNumber(payload.quantity);
  const greenQuantityKg = toNumber(payload.green_quantity_kg);
  const greenTotalCost = toNumber(payload.green_total_cost);
  const yieldFraction = normalizePercent(payload.yield_percent, 0.8);
  const deliveryCostTotal = toNumber(payload.delivery_cost_total);
  const roastingCostTotal = toNumber(payload.roasting_cost_total);
  const packagingCostTotal = toNumber(payload.packaging_cost_total);
  const bagCostTotal = toNumber(payload.bag_cost_total);
  const unitWeightKg = toNumber(payload.unit_weight_kg);
  const marginFraction = normalizePercent(payload.margin_percent, 0.4);

  const totalAdditionalCost =
    deliveryCostTotal +
    roastingCostTotal +
    packagingCostTotal +
    bagCostTotal;

  const finalLotCost = greenTotalCost + totalAdditionalCost;
  const finalCostPerUnit = quantity > 0 ? finalLotCost / quantity : 0;
  const suggestedPrice = finalCostPerUnit > 0 && marginFraction < 1
    ? finalCostPerUnit / (1 - marginFraction)
    : 0;
  const profitPerUnit = suggestedPrice - finalCostPerUnit;

  const greenCostPerKg = greenQuantityKg > 0 ? greenTotalCost / greenQuantityKg : 0;
  const roastedQuantityKg = greenQuantityKg > 0 && yieldFraction > 0
    ? greenQuantityKg * yieldFraction
    : (quantity > 0 && unitWeightKg > 0 ? quantity * unitWeightKg : 0);
  const packagedWeightKg = quantity > 0 && unitWeightKg > 0 ? quantity * unitWeightKg : 0;
  const finalCostPerKg = packagedWeightKg > 0 ? finalLotCost / packagedWeightKg : 0;
  const estimatedUnitsFromRoast = roastedQuantityKg > 0 && unitWeightKg > 0
    ? Math.floor(roastedQuantityKg / unitWeightKg)
    : 0;

  return {
    quantity,
    green_quantity_kg: roundQty(greenQuantityKg),
    green_total_cost: roundCurrency(greenTotalCost),
    green_cost_per_kg: roundCurrency(greenCostPerKg),
    yield_percent: roundQty(yieldFraction * 100),
    roasted_quantity_kg: roundQty(roastedQuantityKg),
    delivery_cost_total: roundCurrency(deliveryCostTotal),
    roasting_cost_total: roundCurrency(roastingCostTotal),
    packaging_cost_total: roundCurrency(packagingCostTotal),
    bag_cost_total: roundCurrency(bagCostTotal),
    total_additional_cost: roundCurrency(totalAdditionalCost),
    total_packaged_weight_kg: roundQty(packagedWeightKg),
    unit_weight_kg: roundQty(unitWeightKg),
    final_lot_cost: roundCurrency(finalLotCost),
    final_cost_per_unit: roundCurrency(finalCostPerUnit),
    final_cost_per_kg: roundCurrency(finalCostPerKg),
    suggested_price: roundCurrency(suggestedPrice),
    margin_percent: roundQty(marginFraction * 100),
    profit_per_unit: roundCurrency(profitPerUnit),
    estimated_units_from_roast: estimatedUnitsFromRoast,
  };
};

const registerInventoryMovement = async (connection, movement) => {
  const {
    product_id,
    batch_id = null,
    movement_type,
    quantity,
    reference_type = null,
    reference_id = null,
    notes = null,
  } = movement;

  await connection.query(
    `INSERT INTO inventory_movements
      (product_id, batch_id, movement_type, quantity, reference_type, reference_id, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [product_id, batch_id, movement_type, quantity, reference_type, reference_id, notes]
  );
};

module.exports = {
  calculateBatchCosts,
  registerInventoryMovement,
  toNumber,
  roundCurrency,
  roundQty,
};
