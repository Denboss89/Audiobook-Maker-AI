// components/Button.tsx
import React from 'react';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger';
  fullWidth?: boolean;
}

const Button: React.FC<ButtonProps> = ({
  children,
  variant = 'primary',
  fullWidth = false,
  className = '',
  disabled,
  ...props
}) => {
  const baseStyles = 'px-4 py-2 rounded-lg font-semibold transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-opacity-75';
  const widthStyles = fullWidth ? 'w-full' : '';

  let variantStyles = '';
  switch (variant) {
    case 'primary':
      variantStyles = 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500';
      break;
    case 'secondary':
      variantStyles = 'bg-gray-600 text-gray-100 hover:bg-gray-500 focus:ring-gray-400';
      break;
    case 'danger':
      variantStyles = 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500';
      break;
  }

  const disabledStyles = disabled ? 'opacity-50 cursor-not-allowed' : '';

  return (
    <button
      className={`${baseStyles} ${variantStyles} ${widthStyles} ${disabledStyles} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
};

export default Button;